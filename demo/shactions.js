
import * as types from '../types/index.js';
import {sleep} from '../lib/promise.js';

const target = new URL(window.location.toString());
target.port = '8888';
target.pathname = '/';


const nextRequestId = (() => {
  let id = 0;
  return () => 'r' + (++id);
})();





/**
 * @param {string} intent
 * @param {any} payload
 * @return {Promise<any>}
 */
async function doRequest(intent, payload = undefined) {
  const requestId = nextRequestId();

  const req = await fetch(target.toString(), {
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


async function main() {
  const devicesNode = /** @type {HTMLElement} */ (document.getElementById('devices'));

  /** @type {{[id: string]: types.DeviceState}} */
  const stateCache = {};

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
      const device = queryResponse.devices[id];
      stateCache[id] = device;
    });

    devicesNode.textContent = '';
    for (const device of syncResponse.devices) {
      const state = stateCache[device.id] ?? {};

      const liNode = document.createElement('li');
      liNode.textContent = device.id;
      devicesNode.append(liNode);

      if (state.online === false) {
        liNode.append(` offline`);
      }
    }

    await sleep(10 * 1000);
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
