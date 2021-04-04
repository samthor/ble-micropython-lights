import * as http from 'http';
import { listenPromise } from './lib/server.js';
import * as types from '../types/index.js';


/**
 * @param {http.IncomingMessage} req
 */
async function parsePostJson(req) {
  /** @type {Buffer[]} */
  const chunks = [];

  /**
   * @param {Buffer} chunk
   */
  const dataHandler = (chunk) => chunks.push(chunk);
  req.on('data', dataHandler);

  return new Promise((resolve, reject) => {
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        resolve(payload);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}


export async function createSmartHomeActionsSever(port = 8888) {

  /**
   * @param {types.AssistantRequest} payload
   */
  const requestHandler = (payload) => {




  };

  const httpServer = http.createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404);
      return res.end();
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }

    parsePostJson(req).then(requestHandler).catch((err) => {
      console.warn('got bad shactions request', err);
      res.writeHead(500);
    }).finally((response) => {
      // Write any outstanding data.
      return /** @type {Promise<void>} */ (new Promise((r) => {
        if (response) {
          res.write(JSON.stringify(response), () => r());
        } else {
          r();
        }
        res.end();
      }));
    });
  });

  await listenPromise(httpServer, port);

}