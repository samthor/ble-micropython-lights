import sys
sys.path.append("")  # for aioble

from micropython import const

import uasyncio as asyncio
import aioble
from aioble import security
import bluetooth
import time
import pyb
import collections


"""
TODO: try two BLE coroutines-

1. scan coroutine
  - finds matching devices, inserts at end of list (if not contained)
  - retries if fails
2. task coroutine
  - gets next device to read/update, read/updates it (pull state atomically)
  - write global state
3. network/button coroutine
  - just inserts stuff into top of queue to work
  (somewhere? broadcast)
"""


control_service_uuid = bluetooth.UUID('720a9080-9c7d-11e5-a7e3-0002a5d5c51b')

state_uuid = bluetooth.UUID('720a9081-9c7d-11e5-a7e3-0002a5d5c51b')
level_uuid = bluetooth.UUID('720a9082-9c7d-11e5-a7e3-0002a5d5c51b')


all_lights = [
  ('Ensuite', b'\x00\x0D\x6F\xC6\xAA\xF5'),
  ('Bedroom Rear', b'\x00\x0D\x6F\xB3\xDF\x9A'),
  ('Bedroom Front', b'\x00\x0D\x6F\xC6\xAA\xF9'),
  ('Loft', b'\x00\x0D\x6F\xC6\xAA\x88'),
  ('Stairs', b'\x00\x0D\x6F\xBA\x70\x7E'),
  ('Bathroom', b'\x00\x0D\x6F\xCD\x90\xE0'),
  ('Hall', b'\x00\x0D\x6F\xC6\xAA\x79'),
  ('Kitchen Rear', b'\x00\x0D\x6F\xB3\xDF\x37'),
  ('Kitchen Mid', b'\x00\x0D\x6F\xCD\x9B\xA6'),
  ('Kitchen Front', b'\x00\x0D\x6F\xCD\x94\xE1'),
  ('Living TV side', b'\x00\x0D\x6F\xCF\xB6\xD3'),
  ('Living couch', b'\x00\x0D\x6F\xBA\x6E\x3D'),
  ('Entryway', b'\x00\x0D\x6F\xC6\xAA\x3B'),
  ('Front', b'\x00\x0D\x6F\xCB\xF1\x99'),
]

def lights_to_dict():
  all_lights_dict = dict()
  for name, addr in all_lights:
    all_lights_dict[addr] = name
  return all_lights_dict


all_lights_dict = lights_to_dict()


enabled = set(['Kitchen Front', 'Hall', 'Kitchen Rear'])


security.load_secrets()


device_cache = dict()
pending_command = dict()


UPDATE_DELAY = 20


class SeenRecord(object):
  def __init__(self, status = None, ok = False):
    delay = 20
    if not ok:
      delay = 5

    self.update_at = time.time() + delay
    self.status = status



def value_for_on(target):
  if target:
    return b'\x01'
  else:
    return b'\x00'


async def find_next_device():
  start = time.time()

  seconds = 60
  async with aioble.scan(
    seconds * 1000, interval_us=30000, window_us=30000, active=True
  ) as scanner:
    async for result in scanner:
      now = time.time()

      if now > start + 1:
        print('.')
        start = now

      name = result.name() or ''
      if not name.startswith('MICRO_DIMMER'):
        continue

      addr = result.device.addr

      prev_data = device_cache.get(addr)
      if prev_data and prev_data.update_at > now:
        continue  # skip, seen recently

      return result.device

  # should never happen ?!
  raise Error('butt')
  return None


async def update_device(device):
  status = None
  ok = False

  prev_data = device_cache.get(device.addr)
  if prev_data:
    status = prev_data.status

  update = pending_command.get(device.addr, None)

  try:
    status = await update_device_internal(device, update)
    ok = True

  except OSError as e:
    print('OSError', e)
    # await asyncio.sleep_ms(100)

  except aioble.GattError as e:
    print('GattError', e)  # not paired?

  except asyncio.TimeoutError as e:
    print('TimeoutError')  # failed to pair

  except aioble.DeviceDisconnectedError as e:
    print('DeviceDisconnectedError', e)  # something with pairing

  # TODO: this is racey (and LED hides even if we have more)
  if ok:
    if device.addr in pending_command:
      pyb.LED(1).off()
      del pending_command[device.addr]

  print('logging', device.addr, 'status', status, 'ok', ok)
  device_cache[device.addr] = SeenRecord(status, ok)

  if not ok:
    asyncio.sleep_ms(20)


async def update_device_internal(device, update):
  connection = await device.connect()
  name = all_lights_dict.get(device.addr, '?')

  async with connection:
    print('Pairing:', name)
    if update is not None:
      print('Has update:', update)
    await connection.pair(timeout_ms = 60000)
    print('Paired!')

    service = await connection.service(control_service_uuid)
    if not service:
      raise Exception('could not load service')

    state_char = await service.characteristic(state_uuid)
    raw_is_on = await state_char.read()

    level_char = await service.characteristic(level_uuid)
    raw_level = await level_char.read()

    # TODO: if we have a goal, just set it here (no check)

    is_on = raw_is_on == b'\x01'

    if update is None:
      return is_on

    target = not is_on
    await state_char.write(value_for_on(target), True)
    print('Light', name, 'on?', is_on, 'we are setting it to', target, 'brightness', raw_level)
    return target


async def main():
  asyncio.create_task(switchcheck())

  while True:
    update = False

    # If we have a pending command then create a Device directly and upate it.
    for addr, update in pending_command.items():
      device = aioble.Device(0, addr)
      print('created virtual', addr)
      break
    else:
      # Otherwise just find a device we haven't used in a while and read its value.
      try:
        device = await find_next_device()
      except OSError as e:
        print('scan OSError', e)
        await asyncio.sleep_ms(100)
        continue


    name = all_lights_dict.get(device.addr, '?')
    if name not in enabled:
      device_cache[device.addr] = SeenRecord(ok = True)
      continue

    await update_device(device)


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

    pending_command[t] = True
    pyb.LED(1).on()


asyncio.run(main())