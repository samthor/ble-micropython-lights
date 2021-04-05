import * as http from 'http';
import { listenPromise } from './lib/server.js';
import * as types from '../types/index.js';
import { allSmartHomeDevices, getByMac, subscribeToChanges, unsubscribeFromChanges } from './devices.js';
import ws from 'ws';


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


/**
 * @param {WebSocket} socket
 */
 function handleSocket(socket) {
  /**
   * @param {string} id
   * @param {types.DeviceState} state
   */
  const sub = (id, state) => {
    socket.send(JSON.stringify({id, state}));
  };

  subscribeToChanges(sub);
  socket.onclose = () => {
    unsubscribeFromChanges(sub);
  };
}


export async function createSmartHomeActionsSever(port = 8888) {

  /**
   * @param {types.AssistantInput} only
   */
  const inputHandler = async (only) => {
    switch (only.intent) {
      case 'action.devices.SYNC': {
        return {
          agentUserId: 'sam',
          devices: allSmartHomeDevices(),
        };
      }

      case 'action.devices.QUERY':
        const {devices} = only.payload;
        const states = await Promise.all(devices.map(async (key) => {
          const device = getByMac(key.id);
          if (!device) {
            return {
              status: 'ERROR',
              errorCode: 'unableToLocateDevice',
            };
          }
          return await device.state();
        }));

        /** @type {{[name: string]: any}} */
        const result = {};
        devices.forEach(({id}, i) => result[id] = states[i]);

        return {devices: result};

      case 'action.devices.EXECUTE': {
        const {commands} = only.payload;

        // Flatten requests to be per-device so we can send them in bulk. Google's API is very
        // broad, and this probably never happens in practice.
        /** @type {{[id: string]: types.AssistantExec[]}} */
        const byDevice = {};
        commands.map((command) => {
          for (const {id} of command.devices) {
            if (!(id in byDevice)) {
              byDevice[id] = [];
            }
            byDevice[id].push(...command.execution ?? []);
          }
        });

        const result = await Promise.all(Object.keys(byDevice).map(async (id) => {
          const exec = byDevice[id];

          const device = getByMac(id);
          if (!device) {
            return {
              status: 'ERROR',
              errorCode: 'unableToLocateDevice',
            };
          }

          const result = await device.exec(exec);
          return {
            ids: [id],
            status: 'SUCCESS',
            ...result,
          };
        }));

        return {
          commands: result,
        }
      };

      case 'action.devices.DISCONNECT':
        // This happens when a user removes themselves from actions. For a demo app
        // this doesn't matter.
        return {};

      default:
        return {
          status: 'ERROR',
          errorCode: 'notSupported',
        };
    }
  };

  /**
   * @param {types.AssistantRequest} payload
   * @return {Promise<types.AssistantResponse>}
   */
  const requestHandler = async (payload) => {
    if (payload.inputs.length !== 1) {
      throw new Error(`expected single input, had: ${payload.inputs.length}`);
    }
    const only = payload.inputs[0];
    const out = await inputHandler(only);

    return {
      requestId: payload.requestId,
      payload: out,
    };
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

    res.setHeader('Access-Control-Allow-Origin', '*');

    // TODO(samthor): Check for oauth lol.

    Promise.resolve().then(async () => {

      try {
        const request = await parsePostJson(req);
        const response = await requestHandler(request);

        await /** @type {Promise<void>} */ (new Promise((r) => {
          res.write(JSON.stringify(response), () => r());
        }));

      } catch (err) {
        console.warn('internal shactions request error', err);
        res.writeHead(500);
      } finally {
        res.end();
      }

    });
  });

  const wss = new ws.Server({noServer: true});

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/') {
      wss.handleUpgrade(request, socket, head, handleSocket);
    } else {
      socket.destroy();
    }
  });

  await listenPromise(httpServer, port);
}