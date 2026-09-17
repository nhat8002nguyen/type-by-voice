import { describe, expect, it } from 'vitest';
import { countWords } from '../src/word-count.js';

describe('countWords', () => {
  it('returns 0 for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t  ')).toBe(0);
  });

  it('trims and splits on whitespace runs', () => {
    expect(countWords('the transcribed text')).toBe(3);
    expect(countWords('  hello   world  ')).toBe(2);
    expect(countWords('one\ttwo\nthree')).toBe(3);
  });
});
