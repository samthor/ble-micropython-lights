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


security.load_secrets()


control_service_uuid = bluetooth.UUID('720a9080-9c7d-11e5-a7e3-0002a5d5c51b')

state_uuid = bluetooth.UUID('720a9081-9c7d-11e5-a7e3-0002a5d5c51b')
level_uuid = bluetooth.UUID('720a9082-9c7d-11e5-a7e3-0002a5d5c51b')


def build_lights_dict():
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
  return {addr: name for name, addr in all_lights}


lights_dict = build_lights_dict()
enabled_lights = set(['Kitchen Front', 'Hall', 'Kitchen Rear'])

pending = collections.OrderedDict()
pending_event = asyncio.Event()
ble_lock = asyncio.Lock()


SINGLE_BLE = True
STATUS_EVERY = 5


async def scan_forever():
  start = time.time()
  print('scan, start:', start)

  async with aioble.scan(0, interval_us=30000, window_us=30000, active=False) as scanner:
    async for result in scanner:
      now = time.time()

      if now > start + STATUS_EVERY:
        print('.')
        start = now

      # The dimmers only have fixed addresses.
      if result.device.addr_type != 0:
        continue
      addr = result.device.addr

      if addr not in lights_dict:
        continue

      print("Got result", result)
      # name = result.name() or ''
      # if not name.startswith('MICRO_DIMMER'):
      #   continue

      if addr in pending:
        continue

      # If pending was empty, we have to wake up the connection task.
      will_notify = len(pending) == 0
      pending[addr] = True

      if will_notify:
        pending_event.set()

  # if SINGLE_BLE is False, this should never happen


async def enact_pending_next(addr, task):
  name = lights_dict.get(addr, '?')
  if name not in enabled_lights:
    # Ignore.
    return

  device = aioble.Device(0, addr)

  name = lights_dict.get(device.addr, '?')
  connection = await device.connect()

  async with connection:
    print('Pairing:', name)
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
    print("STATUS", name, "is_on", is_on)



async def enact_pending():
  locked = False

  while True:
    await pending_event.wait()

    # This awkwardly gets the 1st entry without removing it.
    addr = None
    task = None
    for _addr, _task in pending.items():
      addr, task = _addr, _task
      break
    if not addr:
      raise Exception('notified without pending tasks')

    try:
      await enact_pending_next(addr, task)

    except Exception as e:
      print('err:', addr, name, e.__class__, e)
      await asyncio.sleep_ms(100)
      continue

    # Delete the task if it was the same as when we entered the loop.
    if pending[addr] == task:
      del pending[addr]

      # There's no more tasks after this one, allow main queue to notify us.
      if len(pending) == 0:
        pending_event.clear()




async def main():
  asyncio.create_task(enact_pending())

  if SINGLE_BLE:
    while True:
      async with ble_lock:
        await scan_forever()
  else:
    await scan_forever()
    raise Exception('scan_forever failed')


asyncio.run(main())
