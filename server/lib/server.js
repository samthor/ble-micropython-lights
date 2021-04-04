
import * as net from 'net';

/**
 * @param {net.Server} server
 * @param {number} port
 * @return {Promise<void>}
 */
export async function listenPromise(server, port) {
  await /** @type {Promise<void>} */ (new Promise((r) => {
    server.listen(port, () => r());
  }));
}
