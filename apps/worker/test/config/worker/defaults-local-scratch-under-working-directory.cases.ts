import path from 'node:path';

import { expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseWorkerConfig } from '../../../src/config/worker.js';
import { requiredEnvironment, callbackEnvironment } from './fixture.js';

export function registerDefaultsLocalScratchUnderWorkingDirectory(): void {
  it('defaults local scratch under the working directory and refuses relative overrides', () => {
    const { ARTIFACT_SCRATCH_DIRECTORY: _scratch, ...environment } =
      requiredEnvironment;
    expect(parseWorkerConfig(environment).artifactScratchDirectory).toBe(
      path.resolve('.pertexo/worker-scratch'),
    );
    expect(() =>
      parseWorkerConfig({
        ...environment,
        ARTIFACT_SCRATCH_DIRECTORY: 'relative/path',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('requires an explicit deployed disk scratch directory before delivery starts', () => {
    const { ARTIFACT_SCRATCH_DIRECTORY: _scratch, ...environment } =
      requiredEnvironment;
    let failure: unknown;
    try {
      parseWorkerConfig({
        ...environment,
        ...callbackEnvironment,
        NODE_ENV: 'production',
        CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo',
        CONNECTION_KMS_REGION: 'eu-central-1',
        ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error('Missing configuration refusal');
    expect(failure.cause).toBeInstanceOf(ZodError);
    if (!(failure.cause instanceof ZodError))
      throw new Error('Missing configuration field');
    expect(failure.cause.issues.map((issue) => issue.path)).toContainEqual([
      'ARTIFACT_SCRATCH_DIRECTORY',
    ]);
  });
}
