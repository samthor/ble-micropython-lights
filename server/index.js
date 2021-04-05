#!/usr/bin/env node

import { createBeaconServer } from './beacons.js';
import { createSmartHomeActionsSever } from './smarthome.js';

await createBeaconServer();
await createSmartHomeActionsSever();

console.info('Started...');
