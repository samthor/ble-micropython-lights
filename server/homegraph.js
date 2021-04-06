
import {GoogleAuth} from 'google-auth-library';
import { subscribeToChanges } from './devices.js';
import * as types from '../types/index.js';
import { sleep } from '../lib/promise.js';
import { WorkQueueObject } from './lib/queue.js';


const HOMEGRAPH_AGGREGATE_MS = 250;


const homegraphScope = 'https://www.googleapis.com/auth/homegraph';
const homegraphNotificationUrl = 'https://homegraph.googleapis.com/v1/devices:reportStateAndNotification';


let client = undefined;

/** @type {string} */
let projectId = '';

try {
  const auth = new GoogleAuth({
    scopes: [homegraphScope],
  });
  client = await auth.getClient();
  projectId = await auth.getProjectId();
} catch (e) {
  console.warn('could not get auth client', e);
  console.warn('have you set GOOGLE_APPLICATION_CREDENTIALS=<path> ?');
}


/** @type {WorkQueueObject<types.DeviceState>} */
const changedDevicesQueue = new WorkQueueObject();



async function updateGoogleTask() {
  const requestSuffix = (Math.random() * 255).toString(16).substr(2);
  let requestId = 0;

  for (;;) {
    await changedDevicesQueue.wait();
    await sleep(HOMEGRAPH_AGGREGATE_MS);

    const changedDevices = changedDevicesQueue.retrieve();

    /** @type {types.HomegraphNotificationRequest} */
    const request = {
      agentUserId: 'sam',
      requestId: `${++requestId}_r${requestSuffix}`,
      payload: {devices: {states: changedDevices}},
    };
    console.warn('sending changed state to Google', changedDevices);

    const req = await client.request({url: homegraphNotificationUrl, method: 'POST', body: JSON.stringify(request)});
    if (req.status !== 200) {
      throw new Error(`failed to update: ${req.status}`);
    }
  }
}


if (client) {
  subscribeToChanges((id, state, change) => {
    if (change) {
      changedDevicesQueue.add(id, state);
    }
  });

  // TODO: task restart
  updateGoogleTask();
}

