
import * as types from '../types/index.js';
import {Device} from './model.js';
import * as fs from 'fs';

// @ts-ignore
import JSON5 from 'json5';
import { ClipsalPower } from './types/clipsal.js';
import { broadcastAllBeacons } from './beacons.js';
import { DaikinAC } from './types/daikin.js';


const devicesPath = new URL('../devices.json5', import.meta.url);


/** @type {types.DevicesStore} */
const devicesStore = JSON5.parse(fs.readFileSync(devicesPath));
console.warn('startup has', Object.keys(devicesStore).length, 'known:', devicesStore);

/** @type {{[id: string]: Device}} */
const models = {};

for (const mac in devicesStore) {
  const data = devicesStore[mac];
  data.mac = mac;

  // Converts "aa:bb:cc:dd:ee:ff" to a 6-byte buffer.
  const decodedMac = Buffer.from(mac.split(':').map((raw) => Number('0x' + raw)));
  if (decodedMac.length !== 6) {
    throw new Error(`got bad mac: ${mac}`);
  }
  /**
   * @param {Buffer} payload
   */
  const broadcast = (payload) => {
    if (payload.length !== 10) {
      throw new Error(`got bad payload: ${payload}`);
    }
    return broadcastAllBeacons(Buffer.concat([decodedMac, payload]));
  };

  /** @type {Device} */
  let model;

  switch (data.type) {
    case 'clipsal':
      model = new ClipsalPower(broadcast);
      break;

    case 'daikin-ac-wifi':
      model = new DaikinAC(mac);
      break;

    default:
      model = new Device();
  }

  models[mac] = model;
}


/** @type {Set<(id: string, state: types.DeviceState, change: boolean) => void>} */
const changeSubscribers = new Set();


/**
 * @param {(id: string, state: types.DeviceState, change: boolean) => void} sub
 */
export function subscribeToChanges(sub) {
  changeSubscribers.add(sub);
}


/**
 * @param {(id: string, state: types.DeviceState, change: boolean) => void} sub
 */
export function unsubscribeFromChanges(sub) {
  changeSubscribers.delete(sub);
}


/**
 * @param {Buffer} buffer
 */
export function updateViaBeacon(buffer) {
  if (buffer.length !== 16) {
    console.warn(`got bad incoming buffer:`, buffer.length);
    return;
  }

  const macParts = [];
  for (let i = 0; i < 6; ++i) {
    macParts.push(buffer[i].toString(16).padStart(2, '0'));
  }
  const mac = macParts.join(':').toLowerCase();

  const device = getByMac(mac);
  if (!device) {
    console.warn(`got beacon update for unknown device:`, mac);
    return;
  }

  const change = device.updateViaBeacon(buffer.slice(6));
  Promise.resolve().then(async () => {
    try {
      const state = await device.state();
      changeSubscribers.forEach((sub) => sub(mac, state, change));

      if (change) {
        console.warn('change', mac, state);
      }
    } catch (e) {
      console.warn('got err rebroadcasting state', e);
    }
  });
}



/**
 * @param {string} mac
 * @return {Device?}
 */
export function getByMac(mac) {
  return models[mac] ?? null;
}


export function allSmartHomeDevices() {
  return Object.values(devicesStore).map(convertToSmartHome);
}


/**
 * @param {types.GenericDevice} raw
 * @return {types.Device}
 */
function convertToSmartHome(raw) {
  if (!raw.mac) {
    throw new Error(`missing mac`);
  }

  let willReportState = false;
  let type = '';

  /** @type {string[]} */
  const traits = [];

  /** @type {{[name: string]: any}} */
  const attributes = {};

  /** @type {types.DeviceInfo} */
  const info = {};

  /** @type {string[]} */
  const nicknames = [];

  switch (raw.type) {
    case 'clipsal':
      // TODO: these are switches, could be anything
      info.manufacturer = 'Clipsal';
      info.model = 'Smart Light';
      type = 'action.devices.types.LIGHT';
      traits.push(
        'action.devices.traits.OnOff',
        'action.devices.traits.Brightness',
      );
      nicknames.push(`${raw.name} Light`);
      willReportState = true;
      break;

    case 'daikin-ac-wifi':
      info.manufacturer = 'Daikin';
      info.model = 'AC Wifi';
      type = 'action.devices.types.AC_UNIT';
      traits.push(
        'action.devices.traits.OnOff',
        'action.devices.traits.TemperatureSetting',
        'action.devices.traits.FanSpeed',
      );
      attributes['availableThermostatModes'] = ['on', 'off', 'heat', 'cool', 'heatcool', 'fan-only', 'dry'];
      attributes['thermostatTemperatureUnit'] = 'C';
      attributes['thermostatTemperatureRange'] = {
        minThresholdCelsius: 18,  // actually 10
        maxThresholdCelsius: 25,  // actually 41
      };
      attributes['bufferRangeCelsius'] = 0;
      attributes['availableFanSpeeds'] = {
        ordered: true,
        speeds: [
          {
            speed_name: 'speed_quiet',
            speed_values: [
              {
                speed_synonym: [
                  'quiet',
                  'low',
                  'slow',
                ],
                lang: 'en',
              },
            ],
          },
          {
            speed_name: 'speed_auto',
            speed_values: [
              {
                'speed_synonym': [
                  'auto',
                ],
                lang: 'en',
              },
            ],
          },
        ],
      };
      nicknames.push(`${raw.name} AC`);
      break;

    case 'garage':
      info.manufacturer = 'Smart Door Devices';
      info.model = 'Opener';
      type = 'action.devices.types.GARAGE';
      traits.push(
        'action.devices.traits.OpenClose',
      );
      nicknames.push(`${raw.name} Door`)
      break;

  }

  return {
    id: raw.mac,
    type,
    traits,
    willReportState,
    attributes,
    deviceInfo: info,
    name: {
      name: raw.name,
      nicknames,
    },
  };
}
