
/** @type {WebSocket?} */
let sock = null;


let lights = {};
let renderFrame = 0;



const namesRaw = `
Ensuite	00:0D:6F:C6:AA:F5
Bedroom Rear	00:0D:6F:B3:DF:9A
Bedroom Front	00:0D:6F:C6:AA:F9
Loft	00:0D:6F:C6:AA:88
Stairs	00:0D:6F:BA:70:7E
Bathroom	00:0D:6F:CD:90:E0
Hall	00:0D:6F:C6:AA:79
Kitchen Rear	00:0D:6F:B3:DF:37
Kitchen Mid	00:0D:6F:CD:9B:A6
Kitchen Front	00:0D:6F:CD:94:E1
Living TV side	00:0D:6F:CF:B6:D3
Living couch	00:0D:6F:BA:6E:3D
Entryway	00:0D:6F:C6:AA:3B
Front	00:0D:6F:CB:F1:99
`;

const names = {};
namesRaw.split(/\n/g).forEach((cand) => {
  const parts = cand.split('\t');
  if (parts.length !== 2) {
    return;
  }
  names[parts[1].toLowerCase()] = parts[0];
});
console.warn(JSON.stringify(names, undefined, 2));


function reconnectToSocket() {
  const u = new URL(window.location.toString());
  u.protocol = 'ws';
  u.pathname = '/';
  u.port = '9998';
  sock = new WebSocket(u.toString());
  sock.binaryType = 'arraybuffer';

  sock.onmessage = (event) => {
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

  sock.onclose = (event) => {
    lights = {};

    window.setTimeout(() => {
      console.warn('reconnecting');
      reconnectToSocket();
    }, 5000 * Math.random());
  };
}



const formatHex = (raw) => {
  return Array.from(raw).map((v) => {
    return v.toString(16).padStart(2, '0');
  }).join(':');
};

reconnectToSocket();



function sendOnOffCommand(mac, updateOn) {
  const update = new Uint8Array(16);
  update.set(mac, 0);
  update[7] = updateOn;
  update[8] = 255;
  update[9] = 255;
  sock?.send(update);
}


function sendBrightnessCommand(mac, brightness) {
  const update = new Uint8Array(16);
  update.set(mac, 0);
  update[7] = 255;

  const dv = new DataView(update.buffer);
  dv.setUint16(8, brightness);

  sock?.send(update);
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

    liEl.append(' ' + names[addr] ?? '?');
  }
}
