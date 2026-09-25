import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createLocalControlHandler } from '../src/net/local-control.js';

describe('local graceful shutdown control', () => {
  it('requires a token and a loopback peer before invoking shutdown', async () => {
    const onShutdown = vi.fn();
    const handle = createLocalControlHandler({ token: 'test-secret', onShutdown });
    const server = http.createServer((req, res) => {
      if (!handle(req, res)) res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}/internal/shutdown`;
      expect((await fetch(endpoint, { method: 'POST' })).status).toBe(403);
      expect((await fetch(endpoint, { method: 'POST', headers: {
        Authorization: 'Bearer wrong-secret',
      } })).status).toBe(403);
      expect(onShutdown).not.toHaveBeenCalled();
      expect((await fetch(endpoint, { method: 'POST', headers: {
        Authorization: 'Bearer test-secret',
      } })).status).toBe(202);
      await new Promise(setImmediate);
      expect(onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('accepts a tokened self-connection through a LAN bind but rejects a remote peer', async () => {
    const onShutdown = vi.fn();
    const makeResponse = () => ({
      status: 0,
      writeHead(status) { this.status = status; return this; },
      end() { return this; },
    });
    const disabled = createLocalControlHandler({ onShutdown });
    const hidden = makeResponse();
    expect(disabled({ url: '/internal/shutdown' }, hidden)).toBe(true);
    expect(hidden.status).toBe(404);
    const enabled = createLocalControlHandler({ token: 'test-secret', onShutdown });
    const remote = makeResponse();
    enabled({ url: '/internal/shutdown', method: 'POST',
      headers: { authorization: 'Bearer test-secret' },
      socket: { remoteAddress: '192.0.2.10', localAddress: '192.0.2.20' },
    }, remote);
    expect(remote.status).toBe(403);
    expect(onShutdown).not.toHaveBeenCalled();

    const self = makeResponse();
    enabled({ url: '/internal/shutdown', method: 'POST',
      headers: { authorization: 'Bearer test-secret' },
      socket: { remoteAddress: '192.0.2.20', localAddress: '192.0.2.20' },
    }, self);
    expect(self.status).toBe(202);
    await new Promise(setImmediate);
    expect(onShutdown).toHaveBeenCalledTimes(1);

    const wrongToken = makeResponse();
    enabled({ url: '/internal/shutdown', method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
      socket: { remoteAddress: '192.0.2.20', localAddress: '192.0.2.20' },
    }, wrongToken);
    expect(wrongToken.status).toBe(403);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});
