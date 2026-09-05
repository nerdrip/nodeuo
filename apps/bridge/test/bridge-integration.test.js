import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { huffmanCompress } from '@uo/protocol';

const bridgeMain = fileURLToPath(new URL('../src/main.js', import.meta.url));
const children = new Set();

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function waitForLine(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${output}`)), 5_000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      resolve(output);
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
  });
}

function openWebSocket(url, protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { perMessageDeflate: false });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode == null) child.kill('SIGTERM');
  }
  children.clear();
});

describe('browser to classic-UO TCP bridge', () => {
  it('preserves client bytes, adds the ServUO seed and streams fragmented Huffman replies', async () => {
    const expectedReply = Uint8Array.of(0x82, 0x00, 0x1b, 0xff, 0x00, 0x73);
    const compressedReply = huffmanCompress(expectedReply);
    let resolveTcpPayload;
    const tcpPayload = new Promise((resolve) => { resolveTcpPayload = resolve; });
    const target = net.createServer((socket) => {
      const chunks = [];
      let bytes = 0;
      socket.on('data', (chunk) => {
        chunks.push(chunk); bytes += chunk.length;
        if (bytes < 5) return;
        resolveTcpPayload(Buffer.concat(chunks));
        // Separate writes exercise the bridge's stateful stream decoder even
        // when TCP splits a Huffman symbol between reads.
        let offset = 0;
        const writeNext = () => {
          if (offset >= compressedReply.length) return;
          socket.write(Buffer.from(compressedReply.subarray(offset, ++offset)), writeNext);
        };
        writeNext();
      });
    });
    const targetPort = await listen(target);
    const bridgePort = await freePort();
    const child = spawn(process.execPath, [bridgeMain], {
      env: {
        ...process.env,
        UO_BRIDGE_HOST: '127.0.0.1',
        UO_BRIDGE_PORT: String(bridgePort),
        UO_BRIDGE_DEFAULT: `127.0.0.1:${targetPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    await waitForLine(child, /\[bridge\] ws:\/\//);

    const url = `ws://127.0.0.1:${bridgePort}/bridge`;
    await expect(openWebSocket(url, ['unsupported.protocol'])).rejects.toThrow();
    const ws = await openWebSocket(url);
    expect(ws.protocol).toBe('');
    const reply = new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      const timer = setTimeout(() => reject(new Error('timed out waiting for Huffman reply')), 5_000);
      ws.on('message', (data) => {
        const chunk = Buffer.from(data);
        chunks.push(chunk); bytes += chunk.length;
        if (bytes < expectedReply.length) return;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
    });
    const gameLogin = Buffer.alloc(65, 0);
    gameLogin[0] = 0x91;
    ws.send(gameLogin);

    const forwarded = await tcpPayload;
    expect(forwarded.subarray(0, 4)).toEqual(Buffer.from([127, 0, 0, 1]));
    expect(forwarded.subarray(4, 4 + gameLogin.length)).toEqual(gameLogin);
    expect(await reply).toEqual(Buffer.from(expectedReply));
    const health = await fetch(`http://127.0.0.1:${bridgePort}/health`).then((response) => response.json());
    expect(health).toMatchObject({ ok: true, active: 1, opened: 1, rejected: 1 });

    ws.close();
    await new Promise((resolve) => target.close(resolve));
    child.kill('SIGTERM');
  }, 15_000);
});
