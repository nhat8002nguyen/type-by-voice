import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { AccessAuthGuard } from '../auth/access-auth.guard.js';
import { Session } from '../auth/entities/session.entity.js';
import { User } from '../auth/entities/user.entity.js';
import { WORKFLOWS_SERVICE } from '../../../../libs/workflows/src/tokens.js';
import { TranscriptsController } from './transcripts.controller.js';

describe('TranscriptsController', () => {
  async function compile(send: ReturnType<typeof vi.fn>) {
    return Test.createTestingModule({
      controllers: [TranscriptsController],
      providers: [{ provide: WORKFLOWS_SERVICE, useValue: { send } }],
    })
      .overrideGuard(AccessAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
  }

  it('GET /v1/transcripts passes q and userId', async () => {
    const send = vi.fn().mockReturnValue(of({ items: [], nextCursor: undefined }));
    const module = await Test.createTestingModule({
      controllers: [TranscriptsController],
      providers: [{ provide: WORKFLOWS_SERVICE, useValue: { send } }],
    })
      .overrideGuard(AccessAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const result = await module.get(TranscriptsController).list({ userId: 'user-1' }, { q: 'hello' });
    expect(send).toHaveBeenCalledWith('transcripts.search', { userId: 'user-1', q: 'hello' });
    expect(result.items).toEqual([]);
  });

  it('GET /v1/transcripts without q uses transcripts.list with a default limit', async () => {
    const send = vi.fn().mockReturnValue(of({ items: [], nextCursor: undefined }));
    const module = await compile(send);
    const result = await module.get(TranscriptsController).list({ userId: 'user-1' }, {});
    expect(send).toHaveBeenCalledWith('transcripts.list', {
      userId: 'user-1',
      limit: 20,
    });
    expect(result.items).toEqual([]);
  });

  it('GET /v1/transcripts without q forwards cursor and limit', async () => {
    const send = vi.fn().mockReturnValue(of({ items: [], nextCursor: 'c2' }));
    const module = await compile(send);
    await module.get(TranscriptsController).list(
      { userId: 'user-1' },
      { cursor: 'c1', limit: 5 },
    );
    expect(send).toHaveBeenCalledWith('transcripts.list', {
      userId: 'user-1',
      cursor: 'c1',
      limit: 5,
    });
  });

  it('wraps a search array as items', async () => {
    const hits = [
      {
        id: 't1',
        text: 'hello',
        wordCount: 1,
        audioMs: 100,
        createdAt: new Date('2026-09-17T00:00:00.000Z'),
      },
    ];
    const send = vi.fn().mockReturnValue(of(hits));
    const module = await compile(send);
    const result = await module.get(TranscriptsController).list({ userId: 'user-1' }, { q: 'hello' });
    expect(result.items).toEqual(hits);
  });

  it('GET /v1/transcripts/:id sends transcripts.get', async () => {
    const item = {
      id: 't1',
      text: 'hello',
      wordCount: 1,
      audioMs: 100,
      createdAt: new Date('2026-09-17T00:00:00.000Z'),
    };
    const send = vi.fn().mockReturnValue(of(item));
    const module = await compile(send);
    const result = await module.get(TranscriptsController).get({ userId: 'user-1' }, 't1');
    expect(send).toHaveBeenCalledWith('transcripts.get', {
      userId: 'user-1',
      id: 't1',
    });
    expect(result).toEqual(item);
  });

  it('DELETE /v1/transcripts/:id sends transcripts.delete', async () => {
    const send = vi.fn().mockReturnValue(of(undefined));
    const module = await compile(send);
    await module.get(TranscriptsController).delete({ userId: 'user-1' }, 't1');
    expect(send).toHaveBeenCalledWith('transcripts.delete', {
      userId: 'user-1',
      id: 't1',
    });
  });

  it('GET /v1/transcripts/export sends transcripts.export', async () => {
    const items = [
      {
        id: 't1',
        text: 'hello',
        wordCount: 1,
        audioMs: 100,
        createdAt: new Date('2026-09-17T00:00:00.000Z'),
      },
    ];
    const send = vi.fn().mockReturnValue(of(items));
    const module = await compile(send);
    const result = await module.get(TranscriptsController).export({ userId: 'user-1' });
    expect(send).toHaveBeenCalledWith('transcripts.export', { userId: 'user-1' });
    expect(result).toEqual(items);
  });
});

describe('Transcripts HTTP', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  async function createApp(send = vi.fn().mockReturnValue(of([]))) {
    const module = await Test.createTestingModule({
      controllers: [TranscriptsController],
      providers: [{ provide: WORKFLOWS_SERVICE, useValue: { send } }],
    })
      .overrideGuard(AccessAuthGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
          const request = context.switchToHttp().getRequest();
          request.user = {
            id: 'user-1',
            email: 'a@b.co',
            emailVerifiedAt: null,
            sessionId: 'sid-1',
          };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    await app.init();
    return { app, send };
  }

  it('maps CurrentUser.id to userId on search', async () => {
    const { send } = await createApp(vi.fn().mockReturnValue(of({ items: [] })));
    const response = await request(app.getHttpServer()).get('/v1/transcripts?q=hello');
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith('transcripts.search', {
      userId: 'user-1',
      q: 'hello',
    });
  });

  it('returns 204 on delete', async () => {
    await createApp(vi.fn().mockReturnValue(of(undefined)));
    const response = await request(app.getHttpServer()).delete('/v1/transcripts/t1');
    expect(response.status).toBe(204);
  });

  it('GET /v1/transcripts/export is not captured as :id', async () => {
    const items = [{ id: 't1', text: 'hello', wordCount: 1, audioMs: 100, createdAt: '2026-09-17T00:00:00.000Z' }];
    const send = vi.fn().mockReturnValue(of(items));
    await createApp(send);
    const response = await request(app.getHttpServer()).get('/v1/transcripts/export');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(send).toHaveBeenCalledWith('transcripts.export', { userId: 'user-1' });
    expect(response.body).toEqual(items);
  });
});

describe('Transcripts HTTP access guard', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('returns 401 without a bearer token', async () => {
    const module = await Test.createTestingModule({
      controllers: [TranscriptsController],
      providers: [
        AccessAuthGuard,
        { provide: WORKFLOWS_SERVICE, useValue: { send: vi.fn() } },
        { provide: JwtService, useValue: new JwtService({ secret: 'test' }) },
        { provide: getRepositoryToken(Session), useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/v1/transcripts');
    expect(response.status).toBe(401);
  });
});

