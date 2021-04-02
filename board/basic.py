import sys
sys.path.append('')  # for aioble

from micropython import const

import uasyncio as asyncio
import aioble
from aioble import security
import bluetooth
import time
import pyb
import collections
import random
import network
import socket
import select
import struct


security.load_secrets()


server_addr = '192.168.86.39'
server_port = 9999


control_service_uuid = bluetooth.UUID('720a9080-9c7d-11e5-a7e3-0002a5d5c51b')

state_uuid = bluetooth.UUID('720a9081-9c7d-11e5-a7e3-0002a5d5c51b')
level_uuid = bluetooth.UUID('720a9082-9c7d-11e5-a7e3-0002a5d5c51b')


_NOOP_MS = const(10)
_DELAY_MS = const(100)
_BACKOFF_MS = const(1000)
_BACKOFF_MAX = const(8)
_COMMAND_EXPIRY_MS = const(5000)
_CLEANUP_TASK_EVERY_MS = const(1000 * 60)
_STATE_EXPIRY_MS = const(1000 * 60 * 60)  # 1hr

_BRIGHT_MAX = const(10000)
_BRIGHT_BITS = const(10)

_MCAST_PORT = const(9999)


ble_lock = asyncio.Lock()
pending_lock = asyncio.Lock()
pending_update_event = asyncio.Event()


class SeenState(object):
  def __init__(self, is_on, brightness):
    self.is_on = is_on
    self.brightness = brightness
    self.at = time.ticks_ms()
    self.gen = time.ticks_ms()



class PendingCommand(object):
  def __init__(self):
    self.set_on = None
    self.toggle_on = None
    self.set_brightness = None
    self.when = None

  def valid(self):
    if self.when is None:
      # only check validity from the first time this was attempted
      self.when = time.ticks_ms()
    return self.when + _COMMAND_EXPIRY_MS >= time.ticks_ms()


seen_states = {}
pending_command = {}


async def scan():
  await ble_lock.acquire()

  async with aioble.scan(0, interval_us=30000, window_us=30000, active=True) as scanner:
    ble_lock.release()
    print('scanning...')

    async for result in scanner:
      if result.device.addr_type != aioble.ADDR_PUBLIC:
        continue  # only has fixed addresses
      addr = result.device.addr

      if not result.adv_data:
        continue  # we only care if there's a payload

      name = result.name() or ''
      if not name.startswith('MICRO_DIMMER'):
        continue

      raw = None
      for check in result.manufacturer():
        raw = check
      if not raw:
        continue
      key, data = raw

      generation = data[5]                # settings revision count (some change)
      is_on = bool(data[6] & 15)          # Clipsal app checks low bits
      b_ratio = data[7] / 255.0
      brightness = int(round(b_ratio * _BRIGHT_MAX))

      if is_on and not brightness:
        brightness = 1

      prev = seen_states.get(addr, None)
      if prev and prev.is_on == is_on and prev.brightness == brightness:
        prev.at = time.ticks_ms()
        continue

      state = SeenState(is_on, brightness)
      seen_states[addr] = state
      pending_update_event.set()
      print('raw data', list(data))
      print('device', name, 'on=', is_on, 'brightness=', brightness)


async def scan_forever():
  while True:
    await scan()
    await asyncio.sleep_ms(_DELAY_MS)


async def enact_internal(connection, command):
  await connection.pair(timeout_ms = 10 * 1000)

  service = await connection.service(control_service_uuid)
  if not service:
    raise Exception('could not load service')

  if command.set_on is not None:
    state_char = await service.characteristic(state_uuid)
    update = (command.set_on and b'\x01' or b'\00')
    print('writing state', update)
    await state_char.write(update, True)

  elif command.toggle_on:
    state_char = await service.characteristic(state_uuid)
    update = b'\x02'
    print('toggling state', update)
    await state_char.write(update, True)

  if command.set_brightness is not None:
    level_char = await service.characteristic(level_uuid)
    update = command.set_brightness.to_bytes(2, 'little')  # because why the fuck not
    print('toggling state', update)
    await level_char.write(update, True)


async def enact():
  while True:
    if not len(pending_command):
      pyb.LED(1).off()
      await pending_lock.acquire()
      await ble_lock.acquire()

    # Find a random next command to try.
    addr = random.choice(list(pending_command.keys()))
    command = pending_command[addr]
    ok = True

    device = aioble.Device(0, addr)
    try:
      print('enact', addr)
      connection = await device.connect()
      async with connection:
        await enact_internal(connection, command)
      print('enacted!', addr)

    except Exception as e:
      ok = False
      print('exception', e.__class__, 'for', addr)
      print('>----', addr)
      sys.print_exception(e)
      print('<----')

    await asyncio.sleep_ms(_NOOP_MS)

    # If this is still within a valid window, try again.
    if not ok:
      if command.valid():
        continue
      print('abandoned task for', addr, 'command', command)
      await asyncio.sleep_ms(_DELAY_MS)  # scan gets unhappy without this

    del pending_command[addr]
    if not len(pending_command):
      ble_lock.release()



async def read_command(mac, rest):
  pc = PendingCommand()

  # control on/off (or toggle on/off)
  if rest[1] == 2:
    pc.toggle_on = True
  elif rest[1] == 1:
    pc.set_on = True
  elif rest[1] == 0:
    pc.set_on = False

  brightness = int.from_bytes(rest[2:4], 'big')
  if brightness <= _BRIGHT_MAX:
    pc.set_brightness = brightness

  print('command', mac, 'set_on', pc.set_on, 'toggle_on', pc.toggle_on, 'set_brightness', pc.set_brightness)
  pending_command[mac] = pc
  pyb.LED(1).on()

  pending_lock.release()  # allow task to run


async def network_coordinator():
  failures = 0

  while True:
    try:
      reader, writer = await asyncio.open_connection(server_addr, server_port)
      failures = 0

      print('connected to', server_addr + ':' + str(server_port))
      asyncio.create_task(network_update(writer))

      pending = b''
      while True:
        part = await reader.read(1024)
        if not len(part):
          break
        pending += part
        print('got pending', len(pending))

        while len(pending) >= 16:
          command = pending[0:16]
          pending = pending[16:]

          mac = command[0:6]
          rest = command[6:]
          await read_command(mac, rest)

    except Exception as e:
      print('exception network', e.__class__)
      print('>----')
      sys.print_exception(e)
      print('<----')
      failures += 1
      if failures > _BACKOFF_MAX:
        failures = _BACKOFF_MAX


    delay = _BACKOFF_MS * failures
    print('network delaying', delay)
    await asyncio.sleep_ms(delay)



async def network_update(writer):
  sent = {}

  while True:
    for addr in seen_states:
      state = seen_states[addr]
      sent_gen = sent.get(addr, 0)
      if sent_gen == state.gen:
        continue

      # x55 magic for light
      payload = addr + b'\x55' + bytes([state.is_on]) + state.brightness.to_bytes(2, 'big') + bytes([0, 0, 0, 0, 0, 0])
      if len(payload) != 16:
        raise Exception('could not get 16 bytes to send')
      writer.write(payload)
      await writer.drain()

      sent[addr] = state.gen

    await pending_update_event.wait()
    pending_update_event.clear()


async def main():
  await pending_lock.acquire()

  asyncio.create_task(enact())
  asyncio.create_task(scan_forever())
  asyncio.create_task(network_coordinator())

  while True:
    await asyncio.sleep_ms(_CLEANUP_TASK_EVERY_MS)
    threshold = time.ticks_ms() - _STATE_EXPIRY_MS
    for addr in seen_states:
      state = seen_states[addr]
      if state.at < threshold:
        del(seen_states[addr])


asyncio.run(main())


