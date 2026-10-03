import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CommitQuotaRequestDto } from './commit-quota.dto.js';

const base = {
  userId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  sessionId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
  platform: 'macos',
  clientVersion: '1.0.0+12',
  audioMs: 5000,
  wordCount: 20,
  provider: 'groq-whisper',
  providerLatencyMs: 300,
  estimatedCostMicros: 10,
};

describe('CommitQuotaRequestDto', () => {
  it('accepts language vi and translateToEnglish true', async () => {
    const dto = Object.assign(new CommitQuotaRequestDto(), base, {
      language: 'vi',
      translateToEnglish: true,
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('accepts an omitted language and translateToEnglish', async () => {
    const dto = Object.assign(new CommitQuotaRequestDto(), base);
    expect(await validate(dto)).toEqual([]);
  });

  it('rejects an unsupported language', async () => {
    const dto = Object.assign(new CommitQuotaRequestDto(), base, {
      language: 'fr',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(['language']);
  });
});
