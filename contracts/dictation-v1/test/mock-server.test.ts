import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadFixture } from '../src/fixtures.js';
import { startMockDictateServer } from '../src/mock-server.js';
import type { FinalMessage, ReadyMessage, StartMessage } from '../src/types.js';

const audioDir = join(dirname(fileURLToPath(import.meta.url)), '../audio');

function connect(url: string, headers?: Record<string, string>) {
  return new WebSocket(url, { headers });
}

async function nextTyped<T extends { type: string }>(ws: WebSocket, type: T['type']): Promise<T> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(String(data)) as T;
      if (parsed.type === type) {
        ws.off('message', onMessage);
        resolve(parsed);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('mock dictate server', () => {
  it('closes 4401 without a bearer token', async () => {
    const server = await startMockDictateServer({ port: 0 });
    const ws = connect(server.url);
    try {
      const code = await new Promise<number>((resolve) => ws.on('close', resolve));
      expect(code).toBe(4401);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('closes 4403 when quota is exceeded', async () => {
    const server = await startMockDictateServer({ port: 0, quotaExceeded: true });
    const ws = connect(server.url, { Authorization: 'Bearer test-token' });
    try {
      const code = await new Promise<number>((resolve) => ws.on('close', resolve));
      expect(code).toBe(4403);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('returns ready then a final transcript for start/audio/stop', async () => {
    const server = await startMockDictateServer({
      port: 0,
      transcript: 'the transcribed text',
    });
    const ws = connect(server.url, { Authorization: 'Bearer test-token' });
    try {
      await new Promise((resolve) => ws.on('open', resolve));
      const readyPromise = nextTyped<ReadyMessage>(ws, 'ready');
      ws.send(JSON.stringify(loadFixture<StartMessage>('start.valid.json')));
      const ready = await readyPromise;
      expect(ready.type).toBe('ready');
      const finalPromise = nextTyped<FinalMessage>(ws, 'final');
      ws.send(readFileSync(join(audioDir, 'speech-1s.ogg')));
      ws.send(JSON.stringify(loadFixture('stop.valid.json')));
      const final = await finalPromise;
      expect(final.text).toBe('the transcribed text');
      expect(final.wordCount).toBe(3);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('replays a cached final for the same start requestId', async () => {
    const server = await startMockDictateServer({
      port: 0,
      transcript: 'the transcribed text',
    });
    const headers = { Authorization: 'Bearer test-token' };
    const first = connect(server.url, headers);
    try {
      await new Promise((resolve) => first.on('open', resolve));
      const readyPromise = nextTyped<ReadyMessage>(first, 'ready');
      first.send(JSON.stringify(loadFixture<StartMessage>('start.valid.json')));
      await readyPromise;
      const finalPromise = nextTyped<FinalMessage>(first, 'final');
      first.send(readFileSync(join(audioDir, 'speech-1s.ogg')));
      first.send(JSON.stringify(loadFixture('stop.valid.json')));
      const firstFinal = await finalPromise;
      first.close();

      const second = connect(server.url, headers);
      try {
        await new Promise((resolve) => second.on('open', resolve));
        const replayPromise = nextTyped<FinalMessage>(second, 'final');
        second.send(JSON.stringify(loadFixture<StartMessage>('start.valid.json')));
        const replayed = await replayPromise;
        expect(replayed).toEqual(firstFinal);
      } finally {
        second.close();
      }
    } finally {
      first.close();
      await server.close();
    }
  });
});
