import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { TranscribeRequestDto } from './transcribe.dto.js';

describe('TranscribeRequestDto', () => {
  it('rejects a non-uuid requestId', async () => {
    const dto = Object.assign(new TranscribeRequestDto(), {
      requestId: 'not-a-uuid',
      language: 'en',
      audioBase64: 'Zg==',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(['requestId']);
  });

  it('accepts language vi and optional translateToEnglish', async () => {
    const dto = Object.assign(new TranscribeRequestDto(), {
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      language: 'vi',
      translateToEnglish: true,
      audioBase64: 'Zg==',
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('accepts an omitted language for auto-detect', async () => {
    const dto = Object.assign(new TranscribeRequestDto(), {
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      audioBase64: 'Zg==',
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('rejects an unsupported language', async () => {
    const dto = Object.assign(new TranscribeRequestDto(), {
      requestId: '3f2b0c8e-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
      language: 'fr',
      audioBase64: 'Zg==',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(['language']);
  });
});
