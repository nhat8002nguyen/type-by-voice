import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { FinalMessage, StartMessage } from './types.js';

export interface StageTimings {
  connectMs: number;
  readyMs: number;
  uploadMs: number;
  finalMs: number;
  totalMs: number;
}

export interface HarnessRunResult extends StageTimings {
  text: string;
}

export interface HarnessReport {
  runs: number;
  finals: string[];
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
}): Promise<HarnessRunResult> {
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

    const finalPromise = waitForType<FinalMessage>(ws, 'final');
    ws.send(
      JSON.stringify({
        type: 'stop',
        requestId: start.requestId,
        durationMs: 1000,
      }),
    );
    const tStop = performance.now();
    const final = await finalPromise;
    const tFinal = performance.now();

    return {
      connectMs: tOpen - t0,
      readyMs: tReady - tOpen,
      uploadMs: tLastBinary - tReady,
      finalMs: tFinal - tStop,
      totalMs: tFinal - tOpen,
      text: final.text,
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
  onRun?: (result: HarnessRunResult) => void;
}): Promise<HarnessReport> {
  const timings: HarnessRunResult[] = [];
  for (let i = 0; i < options.runs; i++) {
    const result = await runOnce({
      url: options.url,
      token: options.token,
      audio: options.audio,
      start: options.start,
    });
    timings.push(result);
    options.onRun?.(result);
  }

  return {
    runs: options.runs,
    finals: timings.map((timing) => timing.text),
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

function waitForType<T extends { type?: string }>(
  ws: WebSocket,
  type: string,
): Promise<T> {
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
      let parsed: T;
      try {
        parsed = JSON.parse(String(data)) as T;
      } catch {
        return;
      }
      if (parsed.type === type) {
        cleanup();
        resolve(parsed);
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
