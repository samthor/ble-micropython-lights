
import * as types from '../types/index.js';
import * as fs from 'fs';

// @ts-ignore
import JSON5 from 'json5';


const devicesPath = new URL('../devices.json5', import.meta.url);


/** @type {types.DevicesStore} */
const devicesStore = JSON5.parse(fs.readFileSync(devicesPath));
console.warn('startup has', Object.keys(devicesStore).length, 'known:', devicesStore);

for (const mac in devicesStore) {
  devicesStore[mac].mac = mac;
}


/**
 * @param {string} mac
 * @return {types.GenericDevice}
 */
export function getByMac(mac) {
  return devicesStore[mac] ?? {type: '?', name: mac, mac};
}


export function allDevices() {
  return Object.values(devicesStore);
}


/**
 * @param {types.GenericDevice} raw
 * @return {types.Device}
 */
export function convertToSmartHome(raw) {
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
    case 'clipsal-light':
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
      attributes['availableThermostatModes'] = ['heat', 'cool', 'auto', 'fan-only'];
      attributes['thermostatTemperatureUnit'] = 'C';
      attributes['thermostatTemperatureRange'] = {
        minThresholdCelsius: 19,  // actually 10
        maxThresholdCelsius: 25,  // actually 41
      };
      attributes['availableFanSpeeds'] = {
        ordered: true,
        supportsFanSpeedPercent: true,
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
