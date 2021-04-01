import WebSocket from 'ws';
import * as http from 'http';
import * as events from 'events';


export async function createWebSocketServer(port = 9998) {
  const emitter = new events.EventEmitter();

  const httpServer = http.createServer((req, res) => {
    res.writeHead(404);
    return res.end();
  });

  const wss = new WebSocket.Server({noServer: true});

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        emitter.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  await /** @type {Promise<void>} */ (new Promise((r) => {
    httpServer.listen(port, () => r());
  }));

  return emitter;
}
