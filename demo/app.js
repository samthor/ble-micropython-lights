
const u = new URL(window.location.toString());
u.protocol = 'ws';
u.pathname = '/';
u.port = '9998';
const s = new WebSocket(u.toString());
s.binaryType = 'arraybuffer';



const lights = {};
let renderFrame = 0;

const formatHex = (raw) => {
  return Array.from(raw).map((v) => {
    return v.toString(16).padStart(2, '0');
  }).join(':');
};

s.onmessage = (event) => {
  const data = new Uint8Array(event.data);

  const rawMac = data.subarray(0, 6);
  const mac = formatHex(rawMac);
  const isOn = Boolean(data[7]);

  const dv = new DataView(data.buffer);
  const brightness = dv.getUint16(8);

  lights[mac] = {isOn, brightness, mac: rawMac};
  console.warn(mac, isOn, brightness);

  window.cancelAnimationFrame(renderFrame);
  renderFrame = window.requestAnimationFrame(queueRender);
};


function sendOnOffCommand(mac, updateOn) {
  const update = new Uint8Array(16);
  update.set(mac, 0);
  update[7] = updateOn;
  update[8] = 255;
  update[9] = 255;
  s.send(update);
}


function sendBrightnessCommand(mac, brightness) {
  const update = new Uint8Array(16);
  update.set(mac, 0);
  update[7] = 255;

  const dv = new DataView(update.buffer);
  dv.setUint16(8, brightness);

  s.send(update);
}


function queueRender() {
  const lightsEl = /** @type {HTMLElement} */ (document.getElementById('lights'));
  lightsEl.textContent = '';

  for (const addr in lights) {
    const data = lights[addr];

    const liEl = document.createElement('li');
    lightsEl.append(liEl);
    liEl.append(addr, ' ');

    const {isOn, brightness} = lights[addr];

    liEl.append(isOn ? 'on  ' : 'off ');

    const toggleButton = document.createElement('button');
    liEl.append(toggleButton);
    toggleButton.textContent = `${isOn ? 'off' : 'on '}`;

    toggleButton.onclick = sendOnOffCommand.bind(null, data.mac, !isOn);


    const createBrightnessButton = (v) => {
      const b = document.createElement('button');
      b.textContent = v;
      liEl.append(' ', b);

      b.onclick = sendBrightnessCommand.bind(null, data.mac, v);
    };
    createBrightnessButton(0);
    createBrightnessButton(1);
    createBrightnessButton(2500);
    createBrightnessButton(5000);
    createBrightnessButton(10000);

    liEl.append(' ' + brightness);
  }
}
