
import {performance} from 'perf_hooks';
import * as types from '../types/index.js';
import { getByMac } from './devices.js';


const LIGHT_BEACON_TYPE = 0x55;
const BRIGHT_MAX = 10_000;


export class Device {
  mac;
  #device;

  /**
   * @param {string} mac
   */
  constructor(mac) {
    this.mac = mac;
    this.#device = getByMac(mac);
  }

  /**
   * @return {types.GenericDevice}
   */
  toJSON() {
    return Object.assign({}, this.#device);
  }
}


export class Light extends Device {
  isOn = false;
  brightness = 0.0;

  when = performance.now();

  /**
   * @return {types.GenericDevice}
   */
  toJSON() {
    return Object.assign(super.toJSON(), {
      isOn: this.isOn,
      brightness: this.brightness,
    });
  }
}


/**
 * @param {Buffer} buffer
 */
export function decodeBuffer(buffer) {
  if (buffer.length !== 16) {
    return null;
  }

  const macParts = [];
  for (let i = 0; i < 6; ++i) {
    macParts.push(buffer[i].toString(16).padStart(2, '0'));
  }
  const mac = macParts.join(':')

  const type = buffer[6];
  switch (type) {
    case LIGHT_BEACON_TYPE: {
      const l = new Light(mac);

      // 0-6: mac
      // 6: magic for type
      // 7: on/off bit
      // 8: brightness [0,BRIGHT_MAX]
      // 9-15: ???

      l.isOn = Boolean(buffer[7]);
      l.brightness = buffer.readUInt16BE(8) / BRIGHT_MAX;
      return l;
    }
  }

  throw new Error(`unsupported beacon type: ${type}`);
}
