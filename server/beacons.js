import * as net from 'net';
import * as events from 'events';

const PACKET_SIZE = 16;


export async function createBeaconServer(port = 9999) {
  /** @type {Set<net.Socket>} */
  const active = new Set();

  const bs = new BeaconServer((buffer) => {
    active.forEach((socket) => socket.write(buffer));
    return active.size;
  });

  const server = net.createServer((socket) => {
    active.add(socket);
    let pending = Buffer.from([]);

    socket.on('data', (data) => {
      while (data.length + pending.length >= PACKET_SIZE) {
        const front = PACKET_SIZE - pending.length;

        const next = Buffer.concat([pending, data.slice(0, front)]);
        bs.emit('update', next);

        data = data.subarray(front);
      }

      pending = data;
    });

    socket.on('close', (hadError) => {
      console.warn('socket close', hadError);
      active.delete(socket);
    });
  });

  server.on('error', (err) => {
    throw err;
  });

  await /** @type {Promise<void>} */ (new Promise((r) => {
    server.listen(port, () => r());
  }));

  return bs;
}


class BeaconServer extends events.EventEmitter {

  /**
   * @param {(buffer: Buffer) => number} announce
   */
  constructor(announce) {
    super();
    this.announce = announce;
  }

}
