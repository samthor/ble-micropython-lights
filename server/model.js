
import {performance} from 'perf_hooks';


const BRIGHT_MAX = 10_000;


export class Light {
  mac = '';
  isOn = false;
  brightness = 0.0;

  when = performance.now();

  /**
   * @return {Buffer}
   */
  encode() {
    const b = new Uint8ClampedArray(16);
    const dv = new DataView(b.buffer);

    for (let i = 0; i < 6; ++i) {
      b[i] = this.mac.charCodeAt(i);
    }
    b[6] = 0x55;
    b[7] = this.isOn ? 1 : 0;

    const brightness = Math.min(BRIGHT_MAX, this.brightness * BRIGHT_MAX);
    dv.setUint16(8, brightness);

    return Buffer.from(b);
  }

}


/**
 * @param {Buffer} buffer
 */
export function decodeBuffer(buffer) {
  if (buffer.length !== 16) {
    return null;
  }

  const l = new Light();

  l.mac = String.fromCharCode(...buffer.slice(0, 6));
  l.isOn = Boolean(buffer[7]);
  l.brightness = buffer.readUInt16BE(8) / BRIGHT_MAX;

  return l;
}
