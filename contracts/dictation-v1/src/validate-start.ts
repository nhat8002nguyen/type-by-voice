import { PLATFORMS, type Platform } from './constants.js';
import type { StartMessage } from './types.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string) {
  return { ok: false as const, code: 'invalid_request' as const, message };
}

/** validateStart parses a client start message, returning a normalized StartMessage or an invalid_request reason. */
export function validateStart(
  input: unknown,
): { ok: true; value: StartMessage } | { ok: false; code: 'invalid_request'; message: string } {
  if (typeof input !== 'object' || input === null) {
    return fail('start must be an object');
  }
  const value = input as Record<string, unknown>;
  if (value.type !== 'start') {
    return fail('type must be start');
  }
  if (typeof value.requestId !== 'string' || !UUID_V4.test(value.requestId)) {
    return fail('requestId must be UUID v4');
  }
  if (value.codec !== 'opus' || value.container !== 'ogg') {
    return fail('unsupported codec or container');
  }
  if (value.sampleRate !== 16000 || value.channels !== 1) {
    return fail('unsupported audio parameters');
  }
  if (
    value.language !== undefined &&
    value.language !== 'en' &&
    value.language !== 'vi'
  ) {
    return fail('unsupported language');
  }
  if (
    value.translateToEnglish !== undefined &&
    typeof value.translateToEnglish !== 'boolean'
  ) {
    return fail('translateToEnglish must be boolean');
  }
  if (!PLATFORMS.includes(value.platform as Platform)) {
    return fail('unknown platform');
  }
  if (typeof value.clientVersion !== 'string' || value.clientVersion.length === 0) {
    return fail('clientVersion is required');
  }
  if (typeof value.deviceId !== 'string' || !UUID_V4.test(value.deviceId)) {
    return fail('deviceId must be UUID v4');
  }
  if (typeof value.listInHistory !== 'boolean') {
    return fail('listInHistory must be boolean');
  }
  return {
    ok: true,
    value: {
      type: 'start',
      requestId: value.requestId,
      codec: 'opus',
      container: 'ogg',
      sampleRate: 16000,
      channels: 1,
      language: value.language as 'en' | 'vi' | undefined,
      translateToEnglish: value.translateToEnglish === true,
      platform: value.platform as Platform,
      clientVersion: value.clientVersion,
      deviceId: value.deviceId,
      listInHistory: value.listInHistory,
    },
  };
}
