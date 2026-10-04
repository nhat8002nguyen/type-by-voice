import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { clientIp } from './rate-limit/rate-limit.guard.js';
import { applyTrustProxy } from './trust-proxy.js';

/** probeApp builds an Express app carrying the production proxy configuration. */
function probeApp(): Express {
  const app = express();
  applyTrustProxy(app);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip ?? 'none' });
  });
  return app;
}

describe('applyTrustProxy', () => {
  it('resolves request.ip from the forwarded chain rather than the socket peer', async () => {
    const response = await request(probeApp())
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(response.body.ip).toBe('203.0.113.7');
  });

  it('ignores a caller-forged entry left of the address the proxy appended', async () => {
    const response = await request(probeApp())
      .get('/ip')
      .set('X-Forwarded-For', '9.9.9.9, 203.0.113.7');
    expect(response.body.ip).toBe('203.0.113.7');
  });

  it('gives each caller its own address so per-IP limits cannot share one bucket', async () => {
    const app = probeApp();
    const first = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.4');
    const second = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.5');
    expect(first.body.ip).toBe('198.51.100.4');
    expect(second.body.ip).toBe('198.51.100.5');
  });
});

describe('clientIp', () => {
  it('prefers the X-Real-IP that nginx validated over the proxy socket address', () => {
    expect(
      clientIp({ headers: { 'x-real-ip': '203.0.113.7' }, ip: '172.18.0.4' }),
    ).toBe('203.0.113.7');
  });

  it('reads X-Real-IP from a raw WebSocket upgrade request', () => {
    expect(
      clientIp({
        headers: { 'x-real-ip': '203.0.113.9' },
        socket: { remoteAddress: '172.18.0.4' },
      }),
    ).toBe('203.0.113.9');
  });

  it('ignores blank and repeated header values', () => {
    expect(
      clientIp({ headers: { 'x-real-ip': '   ' }, ip: '203.0.113.7' }),
    ).toBe('203.0.113.7');
    expect(
      clientIp({
        headers: { 'x-real-ip': [' 203.0.113.7 ', '10.0.0.1'] },
        ip: '172.18.0.4',
      }),
    ).toBe('203.0.113.7');
  });

  it('falls back to request.ip, then the socket address, then unknown', () => {
    expect(clientIp({ ip: '203.0.113.7' })).toBe('203.0.113.7');
    expect(clientIp({ socket: { remoteAddress: '203.0.113.8' } })).toBe(
      '203.0.113.8',
    );
    expect(clientIp({})).toBe('unknown');
  });
});
