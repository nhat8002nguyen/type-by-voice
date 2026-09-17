import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('backend packaging', () => {
  it('production Dockerfile copies the contracts context before npm ci', () => {
    const production = readFileSync(
      new URL('../../../Dockerfile', import.meta.url),
      'utf8',
    );
    const dev = readFileSync(
      new URL('../../../Dockerfile.dev', import.meta.url),
      'utf8',
    );
    expect(dev).toMatch(/COPY --from=contracts/);
    expect(production).toMatch(/COPY --from=contracts/);
    expect(production).toMatch(/npm ci/);
    const copyIndex = production.indexOf('COPY --from=contracts');
    const ciIndex = production.indexOf('npm ci');
    expect(copyIndex).toBeGreaterThan(-1);
    expect(ciIndex).toBeGreaterThan(copyIndex);
  });
});
