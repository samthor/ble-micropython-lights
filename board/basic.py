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

command_service_uuid = bluetooth.UUID('720a7080-9c7d-11e5-a7e3-0002a5d5c51b')
request_char_uuid = bluetooth.UUID('720a7081-9c7d-11e5-a7e3-0002a5d5c51b')
response_char_uuid = bluetooth.UUID('720a7082-9c7d-11e5-a7e3-0002a5d5c51b')


_DELAY_MS = const(100)
_BACKOFF_MS = const(1000)
_BACKOFF_MAX = const(8)
_COMMAND_EXPIRY_MS = const(5000)
_PAIR_TIMEOUT_MS = const(30 * 1000)


ble_lock = asyncio.Lock()
pending_lock = asyncio.Lock()
pending_update_event = asyncio.Event()


class SeenState(object):
  def __init__(self, is_on, brightness):
    self.is_on = is_on
    self.brightness = brightness



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

  def __str__(self):
    parts = ['PendingCommand']
    if self.set_on is not None:
      parts.append('set_on=' + str(self.set_on))
    if self.toggle_on is not None:
      parts.append('toggle_on=' + str(self.toggle_on))
    if self.set_brightness is not None:
      parts.append('set_brightness=' + str(self.set_brightness))
    if self.when is not None:
      parts.append('when=' + str(self.when))
    return '<' + ' '.join(parts) + '>'

seen_states = {}
pending_command = {}


def build_read_command(register, length = 8):
  if length % 2:
    raise Exception('expected even read')
  return bytes([255, 255, 6, 255, 67]) + register.to_bytes(2, 'big') + (length // 2).to_bytes(2, 'big')


def build_write_command(register, value, length = 8):
  if length % 2:
    raise Exception('expected even write')
  half = length // 2

  while len(value) < length:
    value += b'\x00'

  out = bytes([255, 255, length + 7, 255, 16])
  out += register.to_bytes(2, 'big') + half.to_bytes(2, 'big') + bytes([length]) + value
  return out


async def scan():
  await ble_lock.acquire()

  # scan for ~60s at a time to force restart
  async with aioble.scan(60 * 1000, interval_us=30000, window_us=30000, active=True) as scanner:
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
      brightness = int(round(data[7] / 255.0 * 100.0))

      if is_on and not brightness:
        brightness = 1

      state = SeenState(is_on, brightness)
      seen_states[addr] = state
      pending_update_event.set()
      print('(scan) device', name, 'on=', is_on, 'brightness=', brightness)


async def scan_forever():
  while True:
    await scan()
    await asyncio.sleep_ms(_DELAY_MS)


def log_exception(e, addr=None):
  name = e.__class__.__name__
  known_names = ['TimeoutError', 'DeviceDisconnectedError']
  if name in known_names:
    return name
  if name == 'OSError':
    return name + ': ' + str(e.args[0])

  print('exception', e.__class__, 'for', addr)
  print('>----', addr)
  sys.print_exception(e)
  print('<----')
  return name


async def enact_internal(connection, command):
  print('encrypted? (i.e., probably paired)', connection.encrypted)
  await connection.pair(timeout_ms = _PAIR_TIMEOUT_MS)

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
    brightness = command.set_brightness * 100  # 100 => 10_000
    update = brightness.to_bytes(2, 'little')  # because why the fuck not
    print('toggling state', update)
    await level_char.write(update, True)

  # # get some info while we're here
  # rr_service = await connection.service(command_service_uuid)
  # request_char = await rr_service.characteristic(request_char_uuid)
  # response_char = await rr_service.characteristic(response_char_uuid)

  # await response_char.subscribe()

  # # We need this hack before any notifications arrive.
  # response_char._notify_data = True
  # await response_char.notified()

  # print('writing name command...', list(build_read_command(0x1002, 12)))
  # await request_char.write(build_read_command(0x1002, 12), True)
  # data = await response_char.notified(10 * 1000)
  # print('got name response', data, data[8:].decode('utf-8'))


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
      print('enact', addr, '...')
      connection = await device.connect()
      async with connection:
        await enact_internal(connection, command)
      print('enacted!', addr)

    except Exception as e:
      ok = False
      print(log_exception(e, addr))

    await asyncio.sleep_ms(_DELAY_MS)

    # If this is still within a valid window, try again.
    if not ok:
      if command.valid():
        continue
      print('abandoned task for', addr, 'command', command)
      await asyncio.sleep_ms(_DELAY_MS)  # scan gets unhappy without this

    del pending_command[addr]
    if not len(pending_command):
      ble_lock.release()


def insert_command(addr, pc):
  print('inserting', addr, pc)
  if not len(pending_command):
    pending_lock.release()  # allow task to run

  pending_command[addr] = pc
  pyb.LED(1).on()


async def read_command(mac, rest):
  pc = PendingCommand()

  # control on/off (or toggle on/off)
  if rest[1] == 2:
    pc.toggle_on = True
  elif rest[1] == 1:
    pc.set_on = True
  elif rest[1] == 0:
    pc.set_on = False

  brightness = int(rest[2])
  if brightness <= 100:
    pc.set_brightness = brightness

  insert_command(mac, pc)


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
      print(log_exception(e, server_addr))
      failures += 1
      if failures > _BACKOFF_MAX:
        failures = _BACKOFF_MAX


    delay = _BACKOFF_MS * failures
    print('network delaying', delay)
    await asyncio.sleep_ms(delay)



async def network_update(writer):
  try:
    while True:
      await pending_update_event.wait()
      if len(seen_states) <= 1:
        pending_update_event.clear()
        if len(seen_states) == 0:
          await asyncio.sleep_ms(_DELAY_MS);
          continue # not sure why this happened

      # Find a random next state to send.
      addr = random.choice(list(seen_states.keys()))
      state = seen_states[addr]
      del(seen_states[addr])

      # x55 magic for light
      payload = addr + bytes([0x55, state.is_on, state.brightness, 0, 0, 0, 0, 0, 0, 0])
      if len(payload) != 16:
        raise Exception('could not get 16 bytes to send')
      writer.write(payload)
      await writer.drain()

  except Exception as e:
    print(log_exception(e, server_addr))


async def main():
  await pending_lock.acquire()

  asyncio.create_task(enact())
  asyncio.create_task(scan_forever())
  asyncio.create_task(network_coordinator())

  while True:
    await asyncio.sleep_ms(_DELAY_MS)


asyncio.run(main())


