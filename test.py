
from micropython import const

import os
import bluetooth
import time
import json
import binascii
import network
import socket

import ble_advertising


state_uuid = bluetooth.UUID('720a9081-9c7d-11e5-a7e3-0002a5d5c51b')
level_uuid = bluetooth.UUID('720a9082-9c7d-11e5-a7e3-0002a5d5c51b')


all_lights = [
  # ('Ensuite', b'\x00\x0D\x6F\xC6\xAA\xF5'),
  # ('Bedroom Rear', b'\x00\x0D\x6F\xB3\xDF\x9A'),
  # ('Bedroom Front', b'\x00\x0D\x6F\xC6\xAA\xF9'),
  # ('Loft', b'\x00\x0D\x6F\xC6\xAA\x88'),
  # ('Stairs', b'\x00\x0D\x6F\xBA\x70\x7E'),
  # ('Bathroom', b'\x00\x0D\x6F\xCD\x90\xE0'),
  # ('Hall', b'\x00\x0D\x6F\xC6\xAA\x79'),
  # ('Kitchen Rear', b'\x00\x0D\x6F\xB3\xDF\x37'),
  # ('Kitchen Mid', b'\x00\x0D\x6F\xCD\x9B\xA6'),
  ('Kitchen Front', b'\x00\x0D\x6F\xCD\x94\xE1'),
  # ('Living TV side', b'\x00\x0D\x6F\xCF\xB6\xD3'),
  # ('Living couch', b'\x00\x0D\x6F\xBA\x6E\x3D'),
  # ('Entryway', b'\x00\x0D\x6F\xC6\xAA\x3B'),
]

all_lights_dict = dict()
for name, addr in all_lights:
  all_lights_dict[addr] = name


_IO_CAPABILITY_DISPLAY_ONLY = const(0)
_IO_CAPABILITY_DISPLAY_YESNO = const(1)
_IO_CAPABILITY_KEYBOARD_ONLY = const(2)
_IO_CAPABILITY_NO_INPUT_OUTPUT = const(3)
_IO_CAPABILITY_KEYBOARD_DISPLAY = const(4)


_IRQ_CENTRAL_CONNECT = const(1)
_IRQ_CENTRAL_DISCONNECT = const(2)
_IRQ_GATTS_WRITE = const(3)
_IRQ_GATTS_READ_REQUEST = const(4)
_IRQ_SCAN_RESULT = const(5)
_IRQ_SCAN_DONE = const(6)
_IRQ_PERIPHERAL_CONNECT = const(7)
_IRQ_PERIPHERAL_DISCONNECT = const(8)
_IRQ_GATTC_SERVICE_RESULT = const(9)
_IRQ_GATTC_SERVICE_DONE = const(10)
_IRQ_GATTC_CHARACTERISTIC_RESULT = const(11)
_IRQ_GATTC_CHARACTERISTIC_DONE = const(12)
_IRQ_GATTC_DESCRIPTOR_RESULT = const(13)
_IRQ_GATTC_DESCRIPTOR_DONE = const(14)
_IRQ_GATTC_READ_RESULT = const(15)
_IRQ_GATTC_READ_DONE = const(16)
_IRQ_GATTC_WRITE_DONE = const(17)
_IRQ_GATTC_NOTIFY = const(18)
_IRQ_GATTC_INDICATE = const(19)
_IRQ_GATTS_INDICATE_DONE = const(20)
_IRQ_MTU_EXCHANGED = const(21)
_IRQ_L2CAP_ACCEPT = const(22)
_IRQ_L2CAP_CONNECT = const(23)
_IRQ_L2CAP_DISCONNECT = const(24)
_IRQ_L2CAP_RECV = const(25)
_IRQ_L2CAP_SEND_READY = const(26)
_IRQ_CONNECTION_UPDATE = const(27)
_IRQ_ENCRYPTION_UPDATE = const(28)
_IRQ_GET_SECRET = const(29)
_IRQ_SET_SECRET = const(30)


class SecretManager:
  def __init__(self):
    try:
      self._load_secrets()
    except Exception as e:
      print('failed to load', e)
      self._secrets = {}
      self._save_secrets()

  def get_secret(self, sec_type, index, key):
    ret = self._get_secret(sec_type, index, key)
    print('get secret:', sec_type, index, bytes(key) if key else None, 'result', ret)
    return ret

  def _get_secret(self, sec_type, index, key):
    if key:
      key = sec_type, bytes(key)
      return self._secrets.get(key, None)

    i = 0
    for (t, _key), value in self._secrets.items():
      if t == sec_type:
        if i == index:
          return value
        i += 1

    return None

  def set_secret(self, sec_type, key, value):
    key = sec_type, bytes(key)
    value = bytes(value) if value else None
    print("set secret:", key, value)

    if value is not None:
      self._secrets[key] = value
      return True

    if key in self._secrets:
      del self._secrets[key]
      return True

    return False

  def save(self):
    self._save_secrets()

  def _load_secrets(self):
    self._secrets = {}
    with open('secrets.json', 'r') as f:
      entries = json.load(f)
      for sec_type, key, value in entries:
        self._secrets[sec_type, binascii.a2b_base64(key)] = binascii.a2b_base64(value)

  def _save_secrets(self):
    with open('secrets.json', 'w') as f:
      json_secrets = [
        (sec_type, binascii.b2a_base64(key), binascii.b2a_base64(value))
        for (sec_type, key), value in self._secrets.items()
      ]
      json.dump(json_secrets, f)
    print("saved")
    os.sync()



class LightManager:
  def __init__(self, ble, secret_manager):
    self._secret = secret_manager
    self._ble = ble

    self._ble.config(bond=True)
    self._ble.config(le_secure=True)
    self._ble.config(mitm=True)
    self._ble.config(io=_IO_CAPABILITY_NO_INPUT_OUTPUT)
    self._ble.active(True)

    self._ble.irq(self._irq)

    self._seen = set()
    self._target = None

    self._conn_handle = None
    self._value_handle = None
    self._value = 0

  def flip(self):
    if not self._value_handle:
      print("can't yet write")
    write = b'\x01'
    if self._value:
      write = b'\x00'
      self._value = 0
    else:
      self._value = 1
    print("writing value", write)
    self._ble.gattc_write(self._conn_handle, self._value_handle, write, 1)

  def start(self, seconds):
    # TODO: forever?
    self._ble.gap_scan(seconds * 1000, 30000, 30000)

  def _irq(self, event, data):
    if event == _IRQ_SET_SECRET:
      ret = self._secret.set_secret(*data)
      self._secret.save()
      return ret

    elif event == _IRQ_GET_SECRET:
      return self._secret.get_secret(*data)

    elif event == _IRQ_SCAN_RESULT:
      addr_type, addr, adv_type, rssi, adv_data = data
      addr = bytes(addr)

      if addr in self._seen:
        return

      name = ble_advertising.decode_name(adv_data)
      print('found', name, 'rssi', rssi, 'addr_type', addr_type, 'addr', addr)
      self._seen.add(addr)

      if addr in all_lights_dict:
        if self._target:
          print('light', all_lights_dict[addr], '--ignoring')
          return
        self._target = addr
        print('FOUND LIGHT, connecting', all_lights_dict[addr])
        self._ble.gap_connect(addr_type, addr)

    elif event == _IRQ_PERIPHERAL_CONNECT:
      conn_handle, addr_type, addr = data
      print('connected', bytes(addr))
      self._ble.gap_pair(conn_handle)

    elif event == _IRQ_PERIPHERAL_DISCONNECT:
      conn_handle, addr_type, addr = data
      print('disconnected', bytes(addr), conn_handle, addr_type)

      if addr_type == 255:
        return  # we see this when we disconnect from 00:00:00:00:00
      self._ble.gap_connect(addr_type, addr)

    elif event == _IRQ_SCAN_DONE:
      print('scan done')

    elif event == _IRQ_ENCRYPTION_UPDATE:
      conn_handle, encrypted, authenticated, bonded, key_size = data
      print("encryption update", conn_handle, 'encrypted?', encrypted, 'authenticated?', authenticated, 'bonded?', bonded, 'key_size', key_size)

      if encrypted and bonded:
        print("requesting discover of", state_uuid)
        self._ble.gattc_discover_characteristics(conn_handle, 1, 0xffff, state_uuid)

    elif event == _IRQ_GATTC_CHARACTERISTIC_RESULT:
      conn_handle, def_handle, value_handle, properties, uuid = data
      print('gattc discover, reading value')

      self._value_handle = value_handle
      self._conn_handle = conn_handle

      self._ble.gattc_read(conn_handle, value_handle)

    elif event == _IRQ_GATTC_CHARACTERISTIC_DONE:
      conn_handle, status = data
      print('gattc done', status)

    elif event == _IRQ_GATTC_READ_RESULT:
      conn_handle, value_handle, char_data = data
      print('gattc discover, read:', bytes(char_data))

    elif event == _IRQ_GATTC_READ_DONE:
      print('read done', data)

    elif event == _IRQ_GATTC_WRITE_DONE:
      conn_handle, value_handle, status = data
      print('write_done', status)

    elif event == _IRQ_MTU_EXCHANGED:
      print("mtu exchanged")
      conn_handle, mtu = data

    else:
      print('unhandled _irq', event)

if __name__ == '__main__':
  ble = bluetooth.BLE()
  secret = SecretManager()
  m = LightManager(ble, secret)
  m.start(60)

  sta_if = network.WLAN(network.STA_IF)
  sta_if.active(False)
  time.sleep_ms(100)

  sta_if.active(True)
  sta_if.connect('HausHouse', 'lolbutts44')
  while not sta_if.isconnected():
    time.sleep_ms(100)
  print('connected to wifi', sta_if.ifconfig())

  # TODO: binding to 0.0.0.0 prevents future change
  ip, mask, router, dns = sta_if.ifconfig()
  addr = socket.getaddrinfo(ip, 80)[0][-1]

  s = socket.socket()
  s.bind(addr)
  s.listen(1)

  print('listening on', addr)

  while True:
      cl, addr = s.accept()
      print('client connected from', addr)
      cl_file = cl.makefile('rwb', 0)
      while True:
          line = cl_file.readline()
          if not line or line == b'\r\n':
              break
      m.flip()

      cl.send('HTTP/1.0 200 OK\r\nContent-type: text/html\r\n\r\n')
      cl.send('Hello')
      cl.close()


  while True:
    time.sleep_ms(100)
