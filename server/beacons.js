import * as net from 'net';
import * as events from 'events';
import { listenPromise } from './lib/server.js';
import { updateViaBeacon } from './devices.js';

const PACKET_SIZE = 16;

/** @type {Set<net.Socket>} */
const active = new Set();

/**
 * @param {Buffer} payload
 * @return {number}
 */
export function broadcastAllBeacons(payload) {
  console.warn('broadcast payload', payload, 'to sockets', active.size);

  active.forEach((socket) => {
    socket.write(payload, (err) => {
      if (err) {
        console.warn('could not write payload', payload, err);
      }
    });
  });

  return active.size;
}


export async function createBeaconServer(port = 9999) {
  const server = net.createServer((socket) => {
    active.add(socket);
    let pending = Buffer.from([]);
    console.warn('got new socket', socket.address());

    socket.on('data', (data) => {
      while (data.length + pending.length >= PACKET_SIZE) {
        const front = PACKET_SIZE - pending.length;

        const next = Buffer.concat([pending, data.slice(0, front)]);
        updateViaBeacon(next);

        data = data.subarray(front);
      }

      pending = data;
    });

    // We need this otherwise Node will throw and crash.
    socket.on('error', (err) => {
      console.warn('socket err', err);
      socket.destroy();
    });

    socket.on('close', (hadError) => {
      if (hadError) {
        console.warn('socket close with error');
      }
      console.warn('socket closed', socket.address());
      active.delete(socket);
    });
  });

  server.on('error', (err) => {
    throw err;
  });

  await listenPromise(server, port);
}
