
import * as types from '../types/index.js';


export class Device {

  /**
   * @param {Buffer} buffer 10-byte payload (mac already stripped)
   * @return {types.DeviceState?} non-null if changed
   */
  updateViaBeacon(buffer) {
    throw new Error(`unimplemented`);
  }

  /**
   * @param {types.AssistantExec[]} exec 
   * @return {Promise<types.DeviceState>}
   */
  async exec(exec) {
    return {online: false};
  }

  /**
   * @return {Promise<types.DeviceState>}
   */
  async state() {
    return {online: false};
  }
}
