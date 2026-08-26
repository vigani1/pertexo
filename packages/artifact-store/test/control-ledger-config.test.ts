import { describe, expect, it } from 'vitest';

import { parseControlLedgerConfig } from '../src/control-ledger-config.js';

const ENVIRONMENT = {
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  CONTROL_LEDGER_ACCESS_KEY_ID: 'ledger-access',
  CONTROL_LEDGER_BUCKET: 'pertexo-control-ledger',
  CONTROL_LEDGER_ENDPOINT: 'http://localhost:9090',
  CONTROL_LEDGER_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_REGION: 'us-east-1',
  CONTROL_LEDGER_SECRET_ACCESS_KEY: 'ledger-secret',
} as const;

describe('parseControlLedgerConfig', () => {
  it('parses only the dedicated principal, bucket, and retention inputs', () => {
    expect(parseControlLedgerConfig(ENVIRONMENT)).toEqual({
      accessKeyId: 'ledger-access',
      bucket: 'pertexo-control-ledger',
      endpoint: 'http://localhost:9090',
      forcePathStyle: true,
      minRetentionDays: 30,
      region: 'us-east-1',
      requestTimeoutMs: 5_000,
      secretAccessKey: 'ledger-secret',
    });
  });

  it('does not fall back to artifact-store configuration', () => {
    expect(() =>
      parseControlLedgerConfig({
        ARTIFACT_STORE_ACCESS_KEY_ID: 'artifact-access',
        ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
        ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
        ARTIFACT_STORE_REGION: 'us-east-1',
        ARTIFACT_STORE_SECRET_ACCESS_KEY: 'artifact-secret',
      }),
    ).toThrow();
  });

  it('rejects sharing the artifact bucket', () => {
    expect(() =>
      parseControlLedgerConfig({
        ...ENVIRONMENT,
        CONTROL_LEDGER_BUCKET: ENVIRONMENT.ARTIFACT_STORE_BUCKET,
      }),
    ).toThrow('must be distinct');
  });
});
