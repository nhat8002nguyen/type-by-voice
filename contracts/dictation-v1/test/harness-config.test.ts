import { describe, expect, it } from 'vitest';
import {
  formatFinalLine,
  resolveHarnessAudioPath,
} from '../src/harness-config.js';

describe('resolveHarnessAudioPath', () => {
  const bundled = '/repo/contracts/dictation-v1/audio/speech-1s.ogg';

  it('uses the bundled fixture when HARNESS_AUDIO is unset', () => {
    expect(resolveHarnessAudioPath({}, bundled)).toBe(bundled);
  });

  it('uses HARNESS_AUDIO when set', () => {
    expect(
      resolveHarnessAudioPath({ HARNESS_AUDIO: '/tmp/real-speech.ogg' }, bundled),
    ).toBe('/tmp/real-speech.ogg');
  });

  it('ignores a blank HARNESS_AUDIO', () => {
    expect(resolveHarnessAudioPath({ HARNESS_AUDIO: '   ' }, bundled)).toBe(
      bundled,
    );
  });
});

describe('formatFinalLine', () => {
  it('includes the run number and final text', () => {
    expect(formatFinalLine(1, 'hello from groq')).toBe(
      'run 1 final.text: hello from groq',
    );
  });
});
