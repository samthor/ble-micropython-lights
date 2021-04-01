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
  def __init__(self, set_on = None, set_brightness = None):
    self.set_on = set_on
    self.set_brightness = set_brightness
    self.when = time.ticks_ms()

  def valid(self):
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

      generation = data[5]        # settings revision count (some change)
      is_on = bool(data[6] & 15)  # Clipsal app checks low bits
      brightness = data[7]        # 0-255

      prev = seen_states.get(addr, None)
      if prev and prev.is_on == is_on and prev.brightness == brightness:
        prev.at = time.ticks_ms()
        continue

      state = SeenState(is_on, brightness)
      seen_states[addr] = state
      pending_update_event.set()
      print('device', name, 'on=', is_on, 'state', brightness)


async def scan_forever():
  while True:
    await scan()
    await asyncio.sleep_ms(_DELAY_MS)


async def switchcheck():
  sw = pyb.Switch()
  while True:
    await asyncio.sleep_ms(33)
    state = sw.value()
    if not state:
      continue

    # For now, this tells a specific light to toggle.

    t = b'\x00\x0D\x6F\xC6\xAA\x79'
    if t in pending_command:
      continue

    pending_lock.release()  # allow task to run
    pending_command[t] = PendingCommand()
    pyb.LED(1).on()


async def enact_internal(connection, command, prev_state):
  await connection.pair(timeout_ms = 10 * 1000)

  service = await connection.service(control_service_uuid)
  if not service:
    raise Exception('could not load service')

  state_char = await service.characteristic(state_uuid)
  #          level_char = await service.characteristic(level_uuid)

  set_on = command.set_on
  if prev_state and set_on is None:
    set_on = not prev_state.is_on

  update = (set_on and b'\x01' or b'\00')
  print('writing', update)
  await state_char.write(update, True)

  # We don't update the last seen time here, but just pre-empt any scan updates
  # if we changed states.
  if prev_state:
    prev_state.is_on = set_on


async def enact():
  while True:
    if not len(pending_command):
      pyb.LED(1).off()
      await pending_lock.acquire()
      await ble_lock.acquire()

    # Find a random next command to try.
    addr = random.choice(list(pending_command.keys()))
    command = pending_command[addr]
    prev_state = seen_states.get(addr, None)
    ok = True

    device = aioble.Device(0, addr)
    try:
      print('enact', addr)
      connection = await device.connect()
      async with connection:
        await enact_internal(connection, command, prev_state)

    except Exception as e:
      ok = False
      print('exception', e.__class__, 'for', addr)
      # print('>----', addr)
      # sys.print_exception(e)
      # print('<----')

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


async def network_coordinator():
  failures = 0

  while True:
    try:
      print('connecting to', server_addr + ':' + str(server_port))
      reader, writer = await asyncio.open_connection(server_addr, server_port)
      failures = 0

      asyncio.create_task(network_update(writer))

      while True:
        command = await reader.read(1024)
        if not len(command):
          break

        print('got command', command)

    except Exception as e:
      print('exception network', e.__class__)
      failures += 1
      if failures > _BACKOFF_MAX:
        failures = _BACKOFF_MAX

    delay = _BACKOFF_MS * failures
    await asyncio.sleep_ms(delay)



async def network_update(writer):
  sent = {}

  while True:
    for addr in seen_states:
      state = seen_states[addr]
      sent_gen = sent.get(addr, 0)
      if sent_gen == state.gen:
        continue

      payload = addr + bytes([state.is_on, state.brightness])
      if len(payload) != 8:
        raise Exception('could not get 8 bytes to send')
      writer.write(payload)
      await writer.drain()

      sent[addr] = state.gen

    await pending_update_event.wait()
    pending_update_event.clear()


async def main():
  await pending_lock.acquire()

  asyncio.create_task(switchcheck())
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


