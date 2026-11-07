import { describeProcessFailure } from '@pertexo/observability/server';
import { describe, expect, it } from 'vitest';

import { parseApiConfig } from '../../src/platform/config/api-config.js';

const configured = {
  DATABASE_URL:
    'postgresql://pertexo_app:private-db-password@localhost:5432/pertexo',
  NODE_ENV: 'test',
  ARTIFACT_STORE_ACCESS_KEY_ID: 'private-access-key',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'private-secret-key',
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  ARTIFACT_STORE_ENDPOINT: 'http://localhost:19090',
  ARTIFACT_STORE_REGION: 'us-east-1',
  ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
};

describe('artifact startup diagnostics at the process renderer', () => {
  it.each([
    ['ARTIFACT_STORE_BUCKET', undefined, 'invalid_type'],
    ['ARTIFACT_MAX_BYTES', '0', 'too_small'],
    [
      'ARTIFACT_STORE_FORCE_PATH_STYLE',
      'private-invalid-boolean',
      'invalid_value',
    ],
    [
      'ARTIFACT_STORE_ENDPOINT',
      'ftp://private-endpoint.example.test',
      'custom',
    ],
    ['ARTIFACT_STORE_REQUEST_TIMEOUT_MS', '2', 'too_small'],
  ] as const)(
    'names %s and the issue while keeping rejected values private',
    (setting, value, issue) => {
      let failure: unknown;
      try {
        parseApiConfig({ ...configured, [setting]: value });
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const diagnostic = describeProcessFailure(failure);
      expect(diagnostic).toContain(`${setting} (${issue})`);
      for (const secret of [
        'private-db-password',
        'private-access-key',
        'private-secret-key',
        ...(value === undefined ? [] : [value]),
      ])
        expect(diagnostic).not.toContain(secret);
    },
  );
  it('accepts the complete configuration and keeps its parsed settings', () => {
    expect(parseApiConfig(configured).artifacts).toMatchObject({
      bucket: 'pertexo-artifacts',
      forcePathStyle: true,
      endpoint: 'http://localhost:19090',
    });
  });
});
