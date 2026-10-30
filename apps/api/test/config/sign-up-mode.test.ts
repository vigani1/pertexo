import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseApiConfig } from '../../src/platform/config/api.js';
import { validDeployedEnvironment } from './fixture.js';

describe('the sign-up setting', () => {
  it('leaves a production install starting with no setting', () => {
    expect(() => parseApiConfig(validDeployedEnvironment())).not.toThrow();
  });

  it.each(['invitation', 'open'])('accepts %s', (mode) => {
    expect(() =>
      parseApiConfig({
        ...validDeployedEnvironment(),
        AUTH_SIGN_UP_MODE: mode,
      }),
    ).not.toThrow();
  });

  // docs-deps-product-01: a typo must not silently leave an install open or shut.
  it.fails('refuses a value it does not know', () => {
    expect(() =>
      parseApiConfig({
        ...validDeployedEnvironment(),
        AUTH_SIGN_UP_MODE: 'maybe',
      }),
    ).toThrow();
  });

  // docs-deps-product-01: someone installing this has to be able to find it.
  it.fails('is documented where an install is configured', async () => {
    const example = await readFile(
      new URL('../../../../.env.example', import.meta.url),
      'utf8',
    );
    expect(example).toContain('AUTH_SIGN_UP_MODE');
  });
});
