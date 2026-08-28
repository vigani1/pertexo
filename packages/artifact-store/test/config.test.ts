import { describe, expect, it } from 'vitest';

import {
  parseArtifactStoreConfig,
  parseDualRegionArtifactStoreConfig,
} from '../src/config.js';

const REQUIRED_ENVIRONMENT = {
  ARTIFACT_STORE_ACCESS_KEY_ID: 'local-access',
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
  ARTIFACT_STORE_REGION: 'us-east-1',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'local-secret',
} as const;

describe('parseArtifactStoreConfig', () => {
  it('returns immutable config with bounded defaults', () => {
    const config = parseArtifactStoreConfig(REQUIRED_ENVIRONMENT);

    expect(config).toEqual({
      accessKeyId: 'local-access',
      bucket: 'pertexo-artifacts',
      endpoint: 'http://localhost:9090',
      forcePathStyle: true,
      maxObjectBytes: 10 * 1024 * 1024,
      region: 'us-east-1',
      requestTimeoutMs: 5_000,
      secretAccessKey: 'local-secret',
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses explicit bounds and path style strictly', () => {
    const config = parseArtifactStoreConfig({
      ...REQUIRED_ENVIRONMENT,
      ARTIFACT_MAX_BYTES: '4096',
      ARTIFACT_STORE_FORCE_PATH_STYLE: 'false',
      ARTIFACT_STORE_REQUEST_TIMEOUT_MS: '250',
    });

    expect(config.maxObjectBytes).toBe(4_096);
    expect(config.forcePathStyle).toBe(false);
    expect(config.requestTimeoutMs).toBe(250);
  });

  it.each([
    {},
    { ...REQUIRED_ENVIRONMENT, ARTIFACT_STORE_ENDPOINT: 'ftp://localhost' },
    { ...REQUIRED_ENVIRONMENT, ARTIFACT_STORE_BUCKET: 'INVALID_BUCKET' },
    { ...REQUIRED_ENVIRONMENT, ARTIFACT_MAX_BYTES: '0' },
    { ...REQUIRED_ENVIRONMENT, ARTIFACT_STORE_FORCE_PATH_STYLE: 'yes' },
    { ...REQUIRED_ENVIRONMENT, ARTIFACT_STORE_REQUEST_TIMEOUT_MS: '0' },
  ])('rejects invalid environment %#', (environment) => {
    expect(() => parseArtifactStoreConfig(environment)).toThrow();
  });
});

describe('parseDualRegionArtifactStoreConfig', () => {
  const dualRegionEnvironment = {
    ...REQUIRED_ENVIRONMENT,
    ARTIFACT_STORE_REGION: 'eu-central-1',
    ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'recovery-access',
    ARTIFACT_STORE_RECOVERY_BUCKET: 'pertexo-artifacts-recovery',
    ARTIFACT_STORE_RECOVERY_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
    ARTIFACT_STORE_RECOVERY_FORCE_PATH_STYLE: 'false',
    ARTIFACT_STORE_RECOVERY_REGION: 'eu-west-1',
    ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
  } as const;

  it('parses isolated primary and recovery stores with shared bounds', () => {
    const parsed = parseDualRegionArtifactStoreConfig(dualRegionEnvironment);
    expect(parsed.primary).toMatchObject({
      bucket: 'pertexo-artifacts',
      region: 'eu-central-1',
    });
    expect(parsed.recovery).toMatchObject({
      bucket: 'pertexo-artifacts-recovery',
      maxObjectBytes: 10 * 1024 * 1024,
      region: 'eu-west-1',
    });
  });

  it.each([
    { ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'local-access' },
    { ARTIFACT_STORE_RECOVERY_BUCKET: 'pertexo-artifacts' },
    { ARTIFACT_STORE_RECOVERY_REGION: 'eu-central-1' },
  ])('rejects a shared regional isolation field %#', (override) => {
    expect(() =>
      parseDualRegionArtifactStoreConfig({
        ...dualRegionEnvironment,
        ...override,
      }),
    ).toThrow('must be distinct');
  });
});
