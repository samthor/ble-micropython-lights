
import {SmartHomeError} from '../error.js';
import {Device} from '../model.js';
import {performance} from 'perf_hooks';
import * as types from '../../types/index.js';
import * as dgram from 'dgram';
import { sleep } from '../../lib/promise.js';
import fetch from 'node-fetch';
import { runTask } from '../lib/task.js';


/** @type {{[mac: string]: string}} */
const macToIP = {};


/** @type {{[mode: string]: number}} */
const assistantModeToValue = {
  'heatcool': 0,
  'dry': 2,
  'cool': 3,
  'heat': 4,
  'fan-only': 6,
};


/**
 * @param {string} raw
 * @return {{[name: string]: string}}
 */
function parseValues(raw) {
  /** @type {{[name: string]: string}} */
  const out = {};
  const pairs = raw.split(/,/g);
  for (const pair of pairs) {
    const indexOf = pair.indexOf('=');
    if (indexOf === -1) {
      out[pair] = '';
    } else {
      const left = pair.substr(0, indexOf);
      const right = pair.substr(indexOf + 1);

      // don't include empty values
      out[left] = right === '-' ? '' : right;
    }
  }
  return out;
}


/**
 * @param {number} value
 */
const clampToHalfDegree = (value) => Math.round(value * 2) / 2;


/**
 * @param {() => void} success
 */
async function broadcastTask(success) {
  const sock = dgram.createSocket({type: 'udp4', reuseAddr: true});

  const localPort = await new Promise((resolve, reject) => {
    sock.on('error', (err) => reject(err));
    sock.bind(() => resolve(sock.address().port));
  });
  console.debug('got localPort for daikin dgram broadcast', localPort);

  sock.setBroadcast(true);

  sock.on('message', (message, rinfo) => {
    const values = parseValues(message.toString('utf-8'));

    const macParts = [];
    const rawMac = values.mac ?? '';
    for (let i = 0; i < rawMac.length; i += 2) {
      macParts.push(rawMac.substr(i, 2));
    }
    const mac = macParts.join(':').toLowerCase();

    if (macToIP[mac] === rinfo.address) {
      return;  // already seen this one at this address
    }

    console.debug('found daikin AC device', mac, 'at', rinfo.address);
    macToIP[mac] = rinfo.address;
  });

  const broadcastPayload = Buffer.from('DAIKIN_UDP/common/basic_info', 'utf-8');

  for (;;) {
    const bytes = await new Promise((resolve, reject) => {
      sock.send(broadcastPayload, 30050, '255.255.255.255', (err, bytes) => {
        if (err) {
          reject(err);
        } else {
          resolve(bytes);
        }
      });
    });
    success();

    if (bytes !== broadcastPayload.length) {
      throw new Error(`broadcast payload could not be sent`);
    }
    const when = (120 + Math.random() * 60) * 1000;
    console.info('daikin broadcast ok, retry in', (when / 1000).toFixed(1) + 'sec');
    await sleep(when);
  }
}


runTask('daikin-broadcast', broadcastTask);


async function getValues(mac, type) {
  const ip = macToIP[mac];
  if (!ip) {
    throw new SmartHomeError('deviceNotFound', `missing IP for ${mac}`);
  }
  const response = await fetch(`http://${ip}/aircon/get_${type}_info`);
  return parseValues(await response.text());
}


export class DaikinAC extends Device {
  #mac;

  /**
   * @param {string} mac
   */
  constructor(mac) {
    super();
    this.#mac = mac;
  }

  async state() {
    const sensorValuesPromise = getValues(this.#mac, 'sensor');
    const controlValuesPromise = getValues(this.#mac, 'control');

    let sensorValues;
    let controlValues;
    try {
      // We need Promise.all as otherwise both promises aren't eventually resolved/caught.
      ([sensorValues, controlValues] = await Promise.all([sensorValuesPromise, controlValuesPromise]));
    } catch (e) {
      if (e instanceof SmartHomeError) {
        throw e;
      }
      console.warn('failed to get state', this.#mac, e);
      throw new SmartHomeError('deviceNotFound', `failed to get state for: ${this.#mac}`);
    }

    /** @type {types.DeviceState} */
    const state = {
      online: true,
      on: controlValues['pow'] !== '0',
    };

    // This is the current ambient temp.
    if (+sensorValues['htemp']) {
      state.thermostatTemperatureAmbient = +sensorValues['htemp'];
    }

    // Find its operating mode.
    /** @type {string} */
    let assistantMode = 'off';
    if (state.on) {
      assistantMode = 'heatcool';
      const checkMode = +controlValues['mode'];
      for (const mode in assistantModeToValue){
        if (assistantModeToValue[mode] === checkMode) {
          assistantMode = mode;
          break;
        }
      }
    }
    state.thermostatMode = assistantMode;

    // This is the target setpoint, if any.
    if (+controlValues['stemp']) {
      const v = +controlValues['stemp'];
      if (assistantMode === 'heatcool') {
        state.thermostatTemperatureSetpointLow = v;
        state.thermostatTemperatureSetpointHigh = v;
      } else {
        state.thermostatTemperatureSetpoint = v;
      }
    }

    // If possible, read its fan rate.
    switch (controlValues['f_rate'] ?? '') {
      case 'A':
        state.currentFanSpeedSetting = 'speed_auto';
        break;

      case 'B':
        state.currentFanSpeedSetting = 'speed_quiet';
        break;
    }

    return state;
  }

  /**
   * @param {types.AssistantExec[]} exec 
   * @return {Promise<types.DeviceState>}
   */
  async exec(exec) {
    const ip = macToIP[this.#mac];
    if (!ip) {
      return {online: false};
    }
    const sourceValues = await getValues(this.#mac, 'control');

    // This is the minimum set that needs to be passed to apply any change.
    /** @type {{[name: string]: string}} */
    const values = {
      pow: sourceValues.pow ?? '0',
      mode: sourceValues.mode ?? '0',
      stemp: sourceValues.stemp ?? '20.0',
      shum: sourceValues.shum ?? '50',
      f_rate: sourceValues.f_rate ?? 'A',
      f_dir: sourceValues.f_dir ?? '0',
    };

    for (const e of exec) {
      switch (e.command) {
        case 'action.devices.commands.OnOff': {
          const on = Boolean(e.params.on)
          values['pow'] = on ? '1' : '0';
          break;
        }

        case 'action.devices.commands.ThermostatTemperatureSetRange': {
          // We don't really support a range. Set a specific value.
          const high = /** @type {number} */ (e.params.thermostatTemperatureSetpointHigh);
          const low = /** @type {number} */ (e.params.thermostatTemperatureSetpointLow);
          const actualValue = clampToHalfDegree((high + low) / 2);
          values['stemp'] = actualValue.toFixed(1);
          break;
        }

        case 'action.devices.commands.ThermostatTemperatureSetpoint': {
          const temp = /** @type {number} */ (e.params.thermostatTemperatureSetpoint);
          values['stemp'] = clampToHalfDegree(temp).toFixed(1);
          break;
        }

        case 'action.devices.commands.ThermostatSetMode': {
          // TODO(samthor): This will attempt to keep the previous set of values when we change
          // mode. That's probably fine but might break in non-temperature modes (fan, dry).
          const mode = /** @type {string} */ (e.params.thermostatMode);

          if (mode === 'off') {
            // turn off
            values['pow'] = '0';
          } else if (mode === 'on') {
            // "on" sets us to the last used mode.
            values['pow'] = '1';
          } else if (mode !== 'on') {
            // otherwise there's a specific mode request
            const value = assistantModeToValue[mode] ?? 0;
            values['mode'] = value.toString();
            values['pow'] = '1';
          }
          break;
        }

        case 'action.devices.commands.SetFanSpeed': {
          const fanSpeed = /** @type {string} */ (e.params.fanSpeed);
          if (fanSpeed === 'speed_quiet') {
            values['f_rate'] = 'B';
          } else {
            values['f_rate'] = 'A';
          }
          break;
        }

        default:
          throw new SmartHomeError('functionNotSupported', `got unhandled command on AC: ${e.command}`);
      }
    }

    // nb. This is "URL encoded", not comma-separated.
    const body = Object.keys(values).map((key) => `${key}=${values[key]}`).join('&');
    const headers = {'Content-Type': 'application/x-www-form-urlencoded'};
    const args = {method: 'POST', body, headers};
    const response = await fetch(`http://${ip}/aircon/set_control_info`, args);

    const responseValues = parseValues(await response.text());
    if (responseValues.ret !== 'OK') {
      console.warn('failed to do', values, 'response', responseValues);
      throw new SmartHomeError('transientError', `got non-OK response: ${responseValues.ret}`);
    }

    return this.state();
  }
}
