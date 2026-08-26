import { describe, expect, it } from 'vitest';

import {
  parseControlLedgerConfig,
  parseDualRegionControlLedgerConfig,
} from '../src/control-ledger-config.js';

const ENVIRONMENT = {
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  CONTROL_LEDGER_ACCESS_KEY_ID: 'ledger-access',
  CONTROL_LEDGER_BUCKET: 'pertexo-control-ledger',
  CONTROL_LEDGER_ENDPOINT: 'http://localhost:9090',
  CONTROL_LEDGER_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_REGION: 'us-east-1',
  CONTROL_LEDGER_SECRET_ACCESS_KEY: 'ledger-secret',
  CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: 'recovery-access',
  CONTROL_LEDGER_RECOVERY_BUCKET: 'pertexo-control-ledger-recovery',
  CONTROL_LEDGER_RECOVERY_ENDPOINT: 'http://localhost:9091',
  CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS: '31',
  CONTROL_LEDGER_RECOVERY_REGION: 'us-west-1',
  CONTROL_LEDGER_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
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

describe('parseDualRegionControlLedgerConfig', () => {
  it('parses isolated primary and recovery configuration', () => {
    expect(parseDualRegionControlLedgerConfig(ENVIRONMENT)).toEqual({
      primary: {
        accessKeyId: 'ledger-access',
        bucket: 'pertexo-control-ledger',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        minRetentionDays: 30,
        region: 'us-east-1',
        requestTimeoutMs: 5_000,
        secretAccessKey: 'ledger-secret',
      },
      recovery: {
        accessKeyId: 'recovery-access',
        bucket: 'pertexo-control-ledger-recovery',
        endpoint: 'http://localhost:9091',
        forcePathStyle: true,
        minRetentionDays: 31,
        region: 'us-west-1',
        requestTimeoutMs: 5_000,
        secretAccessKey: 'recovery-secret',
      },
    });
  });

  it.each([
    ['regions', { CONTROL_LEDGER_RECOVERY_REGION: 'us-east-1' }],
    ['buckets', { CONTROL_LEDGER_RECOVERY_BUCKET: 'pertexo-control-ledger' }],
    [
      'access key IDs',
      { CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: 'ledger-access' },
    ],
    [
      'artifact bucket',
      { CONTROL_LEDGER_RECOVERY_BUCKET: 'pertexo-artifacts' },
    ],
  ])('rejects shared %s', (_name, override) => {
    expect(() =>
      parseDualRegionControlLedgerConfig({ ...ENVIRONMENT, ...override }),
    ).toThrow('must be distinct');
  });
});
