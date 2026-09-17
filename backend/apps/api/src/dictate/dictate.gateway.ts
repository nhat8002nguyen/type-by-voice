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
export class DictateGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(DictateGateway.name);
  private readonly cache = new IdempotencyCache({ nowMs: () => Date.now() });

  constructor(
    private readonly jwtService: JwtService,
    @Inject(QUOTA_SERVICE) private readonly quota: ClientProxy,
    @Inject(SPEECH_SERVICE) private readonly speech: ClientProxy,
    private readonly outbox: OutboxService,
    private readonly registry: SessionRegistry,
  ) {}

  async handleConnection(client: DictateSocket, req: IncomingMessage): Promise<void> {
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
    if (!payload.sub || !payload.sid || !payload.platform || !payload.deviceId) {
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

    const service = new DictateService(
      this.quota,
      this.speech,
      this.outbox,
      {
        userId: payload.sub,
        sessionId: payload.sid,
        platform: payload.platform,
        deviceId: payload.deviceId,
        clientVersion: '',
      },
      this.cache,
      this.registry,
    );
    client.dictateService = service;
    client.lastActivityMs = Date.now();
    client.messageChain = Promise.resolve();
    client.dictateTimer = setInterval(() => {
      void this.pumpTick(client);
    }, TICK_MS);

    client.on('message', (data) => {
      client.messageChain = (client.messageChain ?? Promise.resolve())
        .then(() => this.handleMessage(client, data))
        .catch(() => undefined);
    });
  }

  handleDisconnect(client: DictateSocket): void {
    if (client.dictateTimer) {
      clearInterval(client.dictateTimer);
      client.dictateTimer = undefined;
    }
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
    const buffer = toBuffer(data);
    let message: ServerTextMessage | undefined;
    try {
      if (Buffer.isBuffer(buffer) && !isUtf8Json(buffer)) {
        message = await service.onBinary(buffer);
      } else {
        message = await service.onText(JSON.parse(buffer.toString('utf8')));
      }
    } catch {
      return;
    }
    this.flush(client, service, message);
  }

  private async pumpTick(client: DictateSocket): Promise<void> {
    const service = client.dictateService;
    if (!service) {
      return;
    }
    const nowMs = Date.now();
    if (
      client.lastActivityMs !== undefined &&
      nowMs - client.lastActivityMs >= SESSION_LIMITS.idleTimeoutMs
    ) {
      client.close(CLOSE_CODES.normal);
      return;
    }
    try {
      const message = await service.onTick(nowMs);
      this.flush(client, service, message);
    } catch {
      return;
    }
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
}

function bearerToken(header: string | string[] | undefined): string | undefined {
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
