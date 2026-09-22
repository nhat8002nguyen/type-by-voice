import { Inject, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { OutboxService } from '@app/outbox';
import { QUOTA_CHECK_PATTERN, QUOTA_SERVICE } from '@app/quota';
import type { CheckQuotaRequestDto, CheckQuotaResponseDto } from '@app/quota';
import { SPEECH_SERVICE } from '@app/speech';
import { TraceContextService } from '@app/tracing';
import {
  CLOSE_CODES,
  ERROR_CODES,
  IdempotencyCache,
  SESSION_LIMITS,
  type Platform,
  type ServerTextMessage,
} from '@type-by-voice/dictation-v1';
import type { IncomingMessage } from 'node:http';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service.js';
import { DictateMetrics } from '../metrics/dictate-metrics.js';
import { AuthLimiter, clientIp } from '../rate-limit/rate-limit.guard.js';
import { DictateService } from './dictate.service.js';
import { SessionRegistry } from './session-registry.js';

const TICK_MS = 1_000;
export const MAX_DICTATION_FRAME_BYTES = 256 * 1024;
const WS_INTERNAL_CLOSE = 1011;

export function closeCodeForAuthError(_error?: unknown): number {
  return CLOSE_CODES.unauthenticated;
}

export function closeCodeForQuota(_reason?: string): number {
  return CLOSE_CODES.quota_exceeded;
}

export function closeCodeForRateLimit(): number {
  return CLOSE_CODES.rate_limited;
}

export function isUtf8Json(data: Buffer): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      continue;
    }
    return byte === 0x7b || byte === 0x5b;
  }
  return false;
}

type SocketData = Buffer | ArrayBuffer | Buffer[] | string;

type DictateSocket = {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  on(event: 'message', listener: (data: SocketData) => void): void;
  dictateService?: DictateService;
  dictateTimer?: ReturnType<typeof setInterval>;
  lastActivityMs?: number;
  messageChain?: Promise<void>;
  connectedAtMs?: number;
  connectMs?: number;
};

@WebSocketGateway({ path: '/v1/dictate', maxPayload: MAX_DICTATION_FRAME_BYTES })
export class DictateGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DictateGateway.name);
  private readonly cache = new IdempotencyCache({ nowMs: () => Date.now() });
  private readonly metrics: DictateMetrics;
  private readonly limiter: Pick<AuthLimiter, 'allowDictateUpgrade'>;

  constructor(
    private readonly jwtService: JwtService,
    @Inject(QUOTA_SERVICE) private readonly quota: ClientProxy,
    @Inject(SPEECH_SERVICE) private readonly speech: ClientProxy,
    private readonly outbox: OutboxService,
    private readonly registry: SessionRegistry,
    private readonly authService: AuthService,
    @Optional() metrics?: DictateMetrics,
    @Optional() limiter?: AuthLimiter,
    @Optional() private readonly traceContext?: TraceContextService,
  ) {
    this.metrics = metrics ?? new DictateMetrics();
    this.limiter = limiter ?? new AuthLimiter();
  }

  async handleConnection(
    client: DictateSocket,
    req: IncomingMessage,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const untilAuth = this.bindInbound(client);
      try {
        await this.authenticateAndAttach(client, req);
      } finally {
        untilAuth.release();
      }
    };
    if (this.traceContext) {
      await this.traceContext.runWithNewTrace(() => run());
      return;
    }
    await run();
  }

  handleDisconnect(client: DictateSocket): void {
    this.clearTick(client);
    const service = client.dictateService;
    if (service) {
      this.registry.remove(service.userId, service.sessionKey);
    }
    client.dictateService = undefined;
  }

  async handleMessage(client: DictateSocket, data: SocketData): Promise<void> {
    const service = client.dictateService;
    if (!service) {
      return;
    }
    client.lastActivityMs = Date.now();
    try {
      const buffer = toBuffer(data);
      if (buffer.byteLength > MAX_DICTATION_FRAME_BYTES) {
        this.flush(
          client,
          service,
          service.failUnexpected(new SyntaxError('frame too large')),
        );
        return;
      }
      const message =
        Buffer.isBuffer(buffer) && !isUtf8Json(buffer)
          ? await service.onBinary(buffer)
          : await service.onText(this.parseText(buffer));
      this.flush(client, service, message);
    } catch (error) {
      this.flush(client, service, service.failUnexpected(error));
    } finally {
      client.lastActivityMs = Date.now();
    }
  }

  private bindInbound(client: DictateSocket): { release: () => void } {
    let releaseAuth!: () => void;
    const untilAuth = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    client.lastActivityMs = Date.now();
    client.messageChain = Promise.resolve();
    client.on('message', (data) => {
      client.lastActivityMs = Date.now();
      client.messageChain = (client.messageChain ?? Promise.resolve())
        .then(() => untilAuth)
        .then(() =>
          this.runTraced(data, () => this.handleMessage(client, data)),
        )
        .catch((error) => {
          this.handleProcessingError(client, error);
        });
    });
    return { release: () => releaseAuth() };
  }

  private async authenticateAndAttach(
    client: DictateSocket,
    req: IncomingMessage,
  ): Promise<void> {
    client.connectedAtMs = Date.now();
    if (!this.limiter.allowDictateUpgrade(clientIp(req))) {
      client.close(closeCodeForRateLimit());
      return;
    }

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      client.close(closeCodeForAuthError());
      return;
    }

    let payload: AccessJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessJwtPayload>(token);
    } catch (error) {
      client.close(closeCodeForAuthError(error));
      return;
    }
    if (
      !payload.sub ||
      !payload.sid
    ) {
      client.close(closeCodeForAuthError());
      return;
    }

    let access: Awaited<ReturnType<AuthService['loadAccessSession']>>;
    try {
      access = await this.authService.loadAccessSession({
        sub: payload.sub,
        sid: payload.sid,
      });
    } catch (error) {
      client.close(closeCodeForAuthError(error));
      return;
    }

    let check: CheckQuotaResponseDto;
    try {
      check = await firstValueFrom(
        this.quota.send<CheckQuotaResponseDto, CheckQuotaRequestDto>(
          QUOTA_CHECK_PATTERN,
          {
            userId: access.user.id,
            sessionId: access.session.id,
            platform: access.session.platform,
            clientVersion: access.session.clientVersion,
            deviceId: access.session.deviceId,
          },
        ),
      );
    } catch {
      client.send(
        JSON.stringify({
          type: 'error',
          requestId: '',
          code: 'internal',
          message: 'Unexpected server error.',
          retryable: ERROR_CODES.internal.retryable,
        }),
      );
      client.close(WS_INTERNAL_CLOSE, 'internal');
      return;
    }
    if (!check.allowed) {
      this.metrics.recordQuotaRejected();
      client.close(closeCodeForQuota(check.reason));
      return;
    }

    client.connectMs = Date.now() - (client.connectedAtMs ?? Date.now());
    client.dictateService = new DictateService(
      this.quota,
      this.speech,
      this.outbox,
      {
        userId: access.user.id,
        sessionId: access.session.id,
        platform: access.session.platform,
        deviceId: access.session.deviceId,
        clientVersion: access.session.clientVersion,
        email: access.user.email,
      },
      this.cache,
      this.registry,
      this.metrics,
    );
    client.dictateTimer = setInterval(() => {
      client.messageChain = (client.messageChain ?? Promise.resolve())
        .then(() => this.pumpTick(client))
        .catch((error) => {
          this.handleProcessingError(client, error);
        });
    }, TICK_MS);
  }

  private runTraced<T>(data: SocketData, fn: () => Promise<T>): Promise<T> {
    if (!this.traceContext) {
      return fn();
    }
    const requestId = peekRequestId(data);
    if (requestId) {
      return Promise.resolve(this.traceContext.run(requestId, () => fn()));
    }
    const existing = this.traceContext.getTraceId();
    if (existing) {
      return Promise.resolve(this.traceContext.run(existing, () => fn()));
    }
    return Promise.resolve(this.traceContext.runWithNewTrace(() => fn()));
  }

  private async pumpTick(client: DictateSocket): Promise<void> {
    const service = client.dictateService;
    if (!service) {
      return;
    }
    const nowMs = Date.now();
    if (!service.isBusy) {
      if (
        client.lastActivityMs !== undefined &&
        nowMs - client.lastActivityMs >= SESSION_LIMITS.idleTimeoutMs
      ) {
        client.close(CLOSE_CODES.normal);
        return;
      }
    }
    try {
      const message = await service.onTick(nowMs);
      this.flush(client, service, message);
    } catch (error) {
      this.flush(client, service, service.failUnexpected(error));
    }
  }

  private handleProcessingError(client: DictateSocket, error: unknown): void {
    const service = client.dictateService;
    if (!service) {
      return;
    }
    this.flush(client, service, service.failUnexpected(error));
  }

  private parseText(buffer: Buffer): unknown {
    return JSON.parse(buffer.toString('utf8'));
  }

  private flush(
    client: DictateSocket,
    service: DictateService,
    message: ServerTextMessage | undefined,
  ): void {
    if (message) {
      client.send(JSON.stringify(message));
      if (message.type === 'final' || message.type === 'error') {
        this.logger.log(
          JSON.stringify({
            requestId: message.requestId,
            platform: service.platform,
            deviceId: service.deviceId,
            type: message.type,
          }),
        );
        if (message.type === 'final') {
          this.metrics.record({
            platform: service.platform,
            connectMs: client.connectMs ?? 0,
            audioReceivedMs: service.audioReceivedMs,
            providerMs: service.providerMs,
            totalMs: Date.now() - (client.connectedAtMs ?? Date.now()),
          });
        }
      }
    }
    const close = service.takePendingClose();
    if (close) {
      client.close(close.code, close.reason);
    }
  }

  private clearTick(client: DictateSocket): void {
    if (client.dictateTimer) {
      clearInterval(client.dictateTimer);
      client.dictateTimer = undefined;
    }
  }
}

type AccessJwtPayload = {
  sub?: string;
  sid?: string;
  platform?: Platform;
  deviceId?: string;
};

function bearerToken(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) {
    return undefined;
  }
  const token = value.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function toBuffer(data: SocketData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (typeof data === 'string') {
    return Buffer.from(data);
  }
  return Buffer.from(new Uint8Array(data));
}

function peekRequestId(data: SocketData): string | undefined {
  try {
    const buffer = toBuffer(data);
    if (!isUtf8Json(buffer)) {
      return undefined;
    }
    const parsed = JSON.parse(buffer.toString('utf8')) as {
      requestId?: unknown;
    };
    return typeof parsed.requestId === 'string' ? parsed.requestId : undefined;
  } catch {
    return undefined;
  }
}
