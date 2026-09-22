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
});
