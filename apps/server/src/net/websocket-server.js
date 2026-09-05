import { WebSocketServer } from 'ws';
import { NODEUO_JSON_SUBPROTOCOL } from '@uo/nodeuo-protocol';
import { NetState } from './net-state.js';

export function createGameWebSocketServer(sharedCtx) {
  let connectionId = 0;
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    },
    handleProtocols(protocols) {
      if (protocols.has(NODEUO_JSON_SUBPROTOCOL)) return NODEUO_JSON_SUBPROTOCOL;
      return false;
    },
  });
  server.on('connection', (ws, req) => {
    const id = ++connectionId;
    const remoteAddress = req.socket.remoteAddress;
    console.log(`[net#${id}] connected from ${remoteAddress}`);
    new NetState(ws, {
      ...sharedCtx,
      id,
      remoteAddress,
      nodeUOTransportVersion: ws.protocol,
    });
  });
  return server;
}
