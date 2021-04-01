#!/usr/bin/env node

import { createBeaconServer } from './beacons.js';
import { createWebSocketServer } from './http.js';
import * as model from './model.js';

const bs = await createBeaconServer();
const wss = await createWebSocketServer();


/** @type {Set<WebSocket>} */
const clients = new Set();


/** @type {Map<string, model.Light>} */
const allLights = new Map();


/**
 * @param {Buffer} buffer
 */
const updateHandler = (buffer) => {
  clients.forEach((socket) => socket.send(buffer));

  const l = model.decodeBuffer(buffer);
  if (!l) {
    console.warn('got bad buffer', buffer);
    return;
  }

  // TODO: expire if we don't see update for ~1hr
  allLights[l.mac] = l;
}
bs.on('update', updateHandler);


/**
 * @param {WebSocket} socket
 */
const socketHandler = (socket) => {
  socket.onmessage = (event) => {
    // TODO: handle request from client
    console.warn('got event', event.data);
  };

  allLights.forEach((l) => {
    socket.send(l.encode());
  });

  clients.add(socket);
  socket.onclose = () => clients.delete(socket);
};
wss.on('connection', socketHandler);
