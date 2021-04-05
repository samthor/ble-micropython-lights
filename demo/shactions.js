
import * as types from '../types/index.js';
import {sleep} from '../lib/promise.js';

const target = new URL(window.location.toString());
target.port = '8888';
target.pathname = '/';

const requestUrl = target.toString();
target.protocol = 'ws';
const socketUrl = target.toString();


const STATE_EXPIRY = 60_000;


/** @type {types.DeviceState} */
const defaultOfflineState = {
  online: false,
};


const nextRequestId = (() => {
  let id = 0;
  return () => 'r' + (++id);
})();



class DeviceElement extends HTMLElement {
  #update;

  /** @type {types.Device=} */
  #device;

  /** @type {types.DeviceState} */
  #state = defaultOfflineState;

  constructor() {
    super();

    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = `
<style>
div {
  font-family: monospace;
  white-space: pre;
}
#actions {
  padding: 0.5em 0 1em;
}
button {
  font: inherit;
  cursor: pointer;
  margin-right: 0.5ch;
}
</style>
<div id="holder"></div>
<div id="actions"></div>
    `;
    const holder = /** @type {HTMLElement} */ (root.getElementById('holder'));
    const actions = /** @type {HTMLElement} */ (root.getElementById('actions'));

    /**
     * @param {string} label
     * @param {{command: string, params: {[name: string]: any}}} exec
     */
    const createButton = (label, exec) => {
      const button = document.createElement('button');
      actions.append(button);
      button.textContent = label;

      button.onclick = () => {
        const detail = exec;
        this.dispatchEvent(new CustomEvent('command', {detail, bubbles: true}));
      };
    };

    /**
     * @param {types.Device=} device
     * @param {types.DeviceState=} state
     */
    this.#update = (device, state) => {
      holder.textContent = '';
      actions.textContent = '';

      if (!device || !state) {
        return;
      }

      /** @type {string[]} */
      const parts = [device.type];

      if (state.online === false) {
        parts.push('offline');
      }

      if ('on' in state) {
        parts.push(`on=${state.on}`);

        const exec = {
          command: 'action.devices.commands.OnOff',
          params: {on: !state.on},
        };
        if (state.on) {
          createButton('Off', exec);
        } else {
          createButton('On', exec);
        }
      }
      if ('brightness' in state) {
        parts.push(`brightness=${state.brightness}`);

        /**
         * @param {number} v
         */
        const createBrightnessButton = (v) => {
          createButton(`${v}`, {
            command: 'action.devices.commands.BrightnessAbsolute',
            params: {brightness: v},
          });
        };
        [0, 1, 50, 100].forEach(createBrightnessButton);
      }
      holder.append(parts.join(' '));

      holder.append(`: ${device.name.name}`);
      holder.append('\n');
    };
  }

  set device(device) {
    this.#device = device;
    this.#update(this.#device, this.#state);
  }

  get device() {
    return this.#device;
  }

  set state(state) {
    this.#state = state;
    this.#update(this.#device, this.#state);
  }

  get state() {
    return this.#state;
  }
}

customElements.define('app-device', DeviceElement);




/**
 * @param {string} intent
 * @param {any} payload
 * @return {Promise<any>}
 */
async function doRequest(intent, payload = undefined) {
  const requestId = nextRequestId();

  const req = await fetch(requestUrl, {
    method: 'POST',
    body: JSON.stringify({
      requestId,
      inputs: [{intent, payload}],
    }),
  });

  /** @type {types.AssistantResponse} */
  const json = await req.json();
  if (json.requestId !== requestId) {
    throw new Error('bad requestId')
  }

  return json.payload;
}


/**
 * @param {types.AssistantCommand} command
 */
async function doCommand(command) {
  const response = await doRequest('action.devices.EXECUTE', {commands: [command]});
  console.warn('command resp', response);
}


async function main() {
  const devicesNode = /** @type {HTMLElement} */ (document.getElementById('devices'));

  /** @type {{[id: string]: {when: number, state: types.DeviceState}}} */
  const stateCache = {};

  const socket = new WebSocket(socketUrl);
  socket.onerror = (event) => {
    console.warn('error in socket', event);
  };
  const socketClosedPromise = /** @type {Promise<void>} */ (new Promise((r) => {
    socket.onclose = (event) => r();
  }));

  socket.onmessage = (event) => {
    /** @type {{id: string, state: types.DeviceState}} */
    const {id, state} = JSON.parse(event.data);
    const q = `[data-id="${id}"]`;
    const el = /** @type {DeviceElement=} */ (document.body.querySelector(q));
    if (el) {
      el.state = state;
      stateCache[id] = {when: performance.now(), state};
    }
  };


  for (;;) {
    /** @type {types.SyncResponse} */
    const syncResponse = await doRequest('action.devices.SYNC');

    /** @type {types.AssistantCommand} */
    const queryRequest = {
      devices: [],
    };
    for (const {id, willReportState} of syncResponse.devices) {
      if (!willReportState || !(id in stateCache)) {
        queryRequest.devices.push({id});
      }
    }

    /** @type {types.QueryResponse} */
    const queryResponse = await doRequest('action.devices.QUERY', queryRequest);
    Object.keys(queryResponse.devices).forEach((id) => {
      const state = queryResponse.devices[id];
      stateCache[id] = {when: performance.now(), state};
    });

    syncResponse.devices.sort(({id: a}, {id: b}) => a.localeCompare(b));

    devicesNode.textContent = '';
    for (const device of syncResponse.devices) {
      let {state, when = -1} = stateCache[device.id];
      if (!state || performance.now() - STATE_EXPIRY > when) {
        delete stateCache[device.id];
        state = defaultOfflineState;
      }

      const liNode = document.createElement('li');
      liNode.textContent = device.id;
      devicesNode.append(liNode);

      const el = new DeviceElement();
      el.setAttribute('data-id', device.id);
      devicesNode.append(el);
      el.addEventListener('command', (event) => {
        const ce = /** @type {CustomEvent<types.AssistantExec>} */ (event);

        /** @type {types.AssistantCommand} */
        const command = {
          devices: [{id: device.id}],
          execution: [ce.detail],
        };
        doCommand(command);
      });

      el.device = device;
      el.state = state;
    }

    await Promise.race([sleep(10 * 1000), socketClosedPromise]);
    if (socket.readyState === WebSocket.CLOSED) {
      throw new Error(`socket closed`);
    }
  }


}


for (;;) {
  try {
    await main();
  } catch (e) {
    console.warn('main error', e);
  }
  await sleep(10 * 1000 * Math.random());
}
