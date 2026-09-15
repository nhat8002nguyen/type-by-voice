import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { StartMessage } from './types.js';

export interface StageTimings {
  connectMs: number;
  readyMs: number;
  uploadMs: number;
  finalMs: number;
  totalMs: number;
}

export interface HarnessReport {
  runs: number;
  stages: {
    connectMs: { p50: number; p95: number };
    readyMs: { p50: number; p95: number };
    uploadMs: { p50: number; p95: number };
    finalMs: { p50: number; p95: number };
    totalMs: { p50: number; p95: number };
  };
}

export function percentile(values: number[], p: 50 | 95): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0),
    sorted.length - 1,
  );
  return sorted[index]!;
}

export async function runOnce(options: {
  url: string;
  token: string;
  audio: Uint8Array;
  start: StartMessage;
}): Promise<StageTimings> {
  const start: StartMessage = { ...options.start, requestId: randomUUID() };
  const t0 = performance.now();
  const ws = new WebSocket(options.url, {
    headers: { Authorization: `Bearer ${options.token}` },
  });

  try {
    const tOpen = await new Promise<number>((resolve, reject) => {
      ws.once('open', () => resolve(performance.now()));
      ws.once('error', reject);
    });

    const readyPromise = waitForType(ws, 'ready');
    ws.send(JSON.stringify(start));
    await readyPromise;
    const tReady = performance.now();

    ws.send(options.audio);
    const tLastBinary = performance.now();

    const finalPromise = waitForType(ws, 'final');
    ws.send(
      JSON.stringify({
        type: 'stop',
        requestId: start.requestId,
        durationMs: 1000,
      }),
    );
    const tStop = performance.now();
    await finalPromise;
    const tFinal = performance.now();

    return {
      connectMs: tOpen - t0,
      readyMs: tReady - tOpen,
      uploadMs: tLastBinary - tReady,
      finalMs: tFinal - tStop,
      totalMs: tFinal - tOpen,
    };
  } finally {
    ws.close();
  }
}

export async function runHarness(options: {
  url: string;
  token: string;
  audio: Uint8Array;
  start: StartMessage;
  runs: number;
}): Promise<HarnessReport> {
  const timings: StageTimings[] = [];
  for (let i = 0; i < options.runs; i++) {
    timings.push(
      await runOnce({
        url: options.url,
        token: options.token,
        audio: options.audio,
        start: options.start,
      }),
    );
  }

  return {
    runs: options.runs,
    stages: {
      connectMs: summarize(timings, 'connectMs'),
      readyMs: summarize(timings, 'readyMs'),
      uploadMs: summarize(timings, 'uploadMs'),
      finalMs: summarize(timings, 'finalMs'),
      totalMs: summarize(timings, 'totalMs'),
    },
  };
}

function summarize(
  timings: StageTimings[],
  key: keyof StageTimings,
): { p50: number; p95: number } {
  const values = timings.map((timing) => timing[key]);
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

function waitForType(ws: WebSocket, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(String(data)) as { type?: string };
      } catch {
        return;
      }
      if (parsed.type === type) {
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`socket closed (${code}) before ${type}`));
    };
    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}
