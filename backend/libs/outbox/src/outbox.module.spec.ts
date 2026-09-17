import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OutboxModule', () => {
  it('does not import a product app path', () => {
    const src = readFileSync(new URL('./outbox.module.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/apps\//);
    expect(src).toMatch(/OutboxModule\.register/);
  });
});
