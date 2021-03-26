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


security.load_secrets()


control_service_uuid = bluetooth.UUID('720a9080-9c7d-11e5-a7e3-0002a5d5c51b')

state_uuid = bluetooth.UUID('720a9081-9c7d-11e5-a7e3-0002a5d5c51b')
level_uuid = bluetooth.UUID('720a9082-9c7d-11e5-a7e3-0002a5d5c51b')


_NOOP_MS = const(10)
_DELAY_MS = const(100)
_COMMAND_EXPIRY_MS = const(5000)



ble_lock = asyncio.Lock()
pending_lock = asyncio.Lock()


class SeenState(object):
  def __init__(self, is_on, brightness):
    self.is_on = is_on
    self.brightness = brightness
    self.at = time.time()



class PendingCommand(object):
  def __init__(self, set_on = None):
    self.set_on = set_on
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
        prev.time = time.time()
        continue

      state = SeenState(is_on, brightness)
      seen_states[addr] = state
      print('device', name, 'on=', is_on, 'state', brightness)


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


async def main():
  await pending_lock.acquire()

  asyncio.create_task(switchcheck())
  asyncio.create_task(enact())

  while True:
    await scan()
    await asyncio.sleep_ms(_DELAY_MS)


asyncio.run(main())