
import {performance} from 'perf_hooks';


export class Light {
  mac = '';
  isOn = false;
  brightness = 0;

  when = performance.now();

  /**
   * @return {Buffer}
   */
  encode() {
    const b = new Uint8ClampedArray(8);

    for (let i = 0; i < 6; ++i) {
      b[i] = this.mac.charCodeAt(i);
    }
    b[6] = this.isOn ? 1 : 0;
    b[7] = this.brightness;

    return Buffer.from(b);
  }

}


/**
 * @param {Buffer} buffer
 */
export function decodeBuffer(buffer) {
  if (buffer.length !== 8) {
    return null;
  }

  const l = new Light();

  l.mac = String.fromCharCode(...buffer.slice(0, 6));
  l.isOn = Boolean(buffer[6]);
  l.brightness = buffer[7];

  return l;
}
