import { Inject, Logger } from '@nestjs/common';
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
import {
  CLOSE_CODES,
  IdempotencyCache,
  SESSION_LIMITS,
  type Platform,
  type ServerTextMessage,
} from '@type-by-voice/dictation-v1';
import type { IncomingMessage } from 'node:http';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service.js';
import { DictateService } from './dictate.service.js';
import { SessionRegistry } from './session-registry.js';

const TICK_MS = 1_000;

export function closeCodeForAuthError(_error?: unknown): number {
  return CLOSE_CODES.unauthenticated;
}

export function closeCodeForQuota(_reason?: string): number {
  return CLOSE_CODES.quota_exceeded;
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
};

type AccessJwtPayload = {
  sub?: string;
  sid?: string;
  platform?: Platform;
  deviceId?: string;
};

@WebSocketGateway({ path: '/v1/dictate' })
export class DictateGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DictateGateway.name);
  private readonly cache = new IdempotencyCache({ nowMs: () => Date.now() });

  constructor(
    private readonly jwtService: JwtService,
    @Inject(QUOTA_SERVICE) private readonly quota: ClientProxy,
    @Inject(SPEECH_SERVICE) private readonly speech: ClientProxy,
    private readonly outbox: OutboxService,
    private readonly registry: SessionRegistry,
    private readonly authService: AuthService,
  ) {}

  async handleConnection(
    client: DictateSocket,
    req: IncomingMessage,
  ): Promise<void> {
    const untilAuth = this.bindInbound(client);
    try {
      await this.authenticateAndAttach(client, req);
    } finally {
      untilAuth.release();
    }
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
        .then(() => this.handleMessage(client, data))
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
      !payload.sid ||
      !payload.platform ||
      !payload.deviceId
    ) {
      client.close(closeCodeForAuthError());
      return;
    }

    let check: CheckQuotaResponseDto;
    try {
      check = await firstValueFrom(
        this.quota.send<CheckQuotaResponseDto, CheckQuotaRequestDto>(
          QUOTA_CHECK_PATTERN,
          {
            userId: payload.sub,
            sessionId: payload.sid,
            platform: payload.platform,
            clientVersion: '',
            deviceId: payload.deviceId,
          },
        ),
      );
    } catch {
      client.close(CLOSE_CODES.normal);
      return;
    }
    if (!check.allowed) {
      client.close(closeCodeForQuota(check.reason));
      return;
    }

    let email: string | undefined;
    try {
      email = (await this.authService.getMe(payload.sub)).email;
    } catch {
      email = undefined;
    }

    client.dictateService = new DictateService(
      this.quota,
      this.speech,
      this.outbox,
      {
        userId: payload.sub,
        sessionId: payload.sid,
        platform: payload.platform,
        deviceId: payload.deviceId,
        clientVersion: '',
        email,
      },
      this.cache,
      this.registry,
    );
    client.dictateTimer = setInterval(() => {
      client.messageChain = (client.messageChain ?? Promise.resolve())
        .then(() => this.pumpTick(client))
        .catch((error) => {
          this.handleProcessingError(client, error);
        });
    }, TICK_MS);
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
        this.logger.log(`requestId=${message.requestId} type=${message.type}`);
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
  return Buffer.from(data);
}
