
import {Device} from '../model.js';
import {performance} from 'perf_hooks';
import * as types from '../../types/index.js';
import { subscribeToChanges, waitForChangesTo } from '../devices.js';


const LIGHT_BEACON_TYPE = 0x55;
const ONLINE_MS = 60_000;
const EXEC_CHANGE_MS = 5_000;


export class ClipsalPower extends Device {
  #mac;
  #isOn = false;
  #brightness = 0;
  #when = -ONLINE_MS;
  #writeToBeacon;

  /**
   * @param {string} mac
   * @param {(buffer: Buffer) => number} writeToBeacon
   */
  constructor(mac, writeToBeacon) {
    super();
    this.#mac = mac;
    this.#writeToBeacon = writeToBeacon;
  }

  /**
   * @param {Buffer} buffer 12-byte payload (mac already stripped)
   * @return {types.DeviceState?}
   */
  updateViaBeacon(buffer) {
    const type = buffer[0];
    if (type !== LIGHT_BEACON_TYPE) {
      throw new Error(`got non-light beacon update: ${type}`);
    }
    const first = this.#when < 0;
    this.#when = performance.now();

    const isOn = Boolean(buffer[1]);
    const brightness = buffer[2];

    if (this.#isOn === isOn && this.#brightness === brightness) {
      if (first) {
        return this.#internalState();
      }
      return null;
    }

    this.#isOn = isOn;
    this.#brightness = brightness;
    return this.#internalState();
  }

  /**
   * @return {types.DeviceState}
   */
  #internalState = () => {
    const online = (performance.now() - this.#when) <= ONLINE_MS;
    if (!online) {
      return {online: false};
    }

    return {
      online: true,
      on: this.#isOn,
      brightness: this.#brightness,
    };
  };

  /**
   * @return {Promise<types.DeviceState>}
   */
  async state() {
    return this.#internalState();
  }

  /**
   * @param {types.AssistantExec[]} exec 
   * @return {Promise<types.DeviceState>}
   */
  async exec(exec) {
    const payload = Buffer.alloc(10, 0);
    payload[0] = LIGHT_BEACON_TYPE;
    payload[1] = 255;
    payload[2] = 255;

    for (const e of exec) {
      switch (e.command) {
        case 'action.devices.commands.OnOff': {
          const on = Boolean(e.params.on);
          payload[1] = on ? 1 : 0;
          break;
        }

        case 'action.devices.commands.BrightnessAbsolute': {
          const brightness = /** @type {number} */ (e.params.brightness);
          payload[2] = brightness;
          break;
        }

        default:
          console.warn('got unhandled command on light:', e.command);
          return {
            online: true,
            errorCode: 'functionNotSupported',
          };
      }
    }

    const writes = this.#writeToBeacon(payload);
    if (writes === 0) {
      return {
        online: false,
      };
    }

    const update = await waitForChangesTo(this.#mac, (change) => {
      // This is probably our change.
      return true;
    }, EXEC_CHANGE_MS);

    // Just return the previous seen state if nothing happens. Google has a pretty strict timeout
    // which means that updating many lights tends to make it unhappy, so we can't wait longer than
    // 5 seconds.
    return update ?? this.#internalState();
  }
}
