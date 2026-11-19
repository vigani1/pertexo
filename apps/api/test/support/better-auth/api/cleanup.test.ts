import { describe, expect, it } from 'vitest';

import {
  FixtureCleanupError,
  FixtureResourceOwner,
} from '../../../browser/harness/resource-owner.js';
import { cleanupFailureReport, DISPOSABLE_DATABASE } from './cleanup.js';

const SECRET = 'postgres://owner:s3cr3t-password@db.internal/pertexo';

class PoolClosedError extends Error {
  public readonly code = 'ERR_POOL_CLOSED';
}

async function ownerFailure(
  resources: readonly Readonly<{ name: string; error: unknown }>[],
): Promise<unknown> {
  const owner = new FixtureResourceOwner();
  for (const resource of resources)
    owner.acquire(resource.name, {}, () => {
      throw resource.error;
    });
  return owner.close().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('Better Auth fixture cleanup report', () => {
  it('names each failed resource with its error class and code, never its message', async () => {
    const error = await ownerFailure([
      { name: 'webhook runtime', error: new Error(SECRET) },
      { name: 'identity runtime', error: new PoolClosedError(SECRET) },
    ]);

    const report = cleanupFailureReport({
      databaseCleanup: undefined,
      beforeClose: { error: new TypeError(SECRET) },
      owner: { error },
    });

    expect(report).toEqual([
      'before close (TypeError)',
      'identity runtime (PoolClosedError ERR_POOL_CLOSED)',
      'webhook runtime (Error)',
    ]);
    expect(JSON.stringify(report)).not.toContain('s3cr3t');
  });

  it('keeps the owner aggregate printable without the original messages', async () => {
    const error = await ownerFailure([
      {
        name: 'API application',
        error: Object.assign(new Error(SECRET), { code: SECRET }),
      },
    ]);

    expect(error).toBeInstanceOf(FixtureCleanupError);
    const aggregate = error as FixtureCleanupError;
    expect(aggregate.message).toBe(
      'Fixture resource cleanup failed: API application (Error)',
    );
    expect(JSON.stringify(aggregate.failures)).not.toContain('s3cr3t');
  });

  it('reports the database by its own label and other resources beside it', async () => {
    const error = await ownerFailure([
      { name: DISPOSABLE_DATABASE, error: new Error(SECRET) },
      { name: 'connection runtime', error: new Error(SECRET) },
    ]);

    expect(
      cleanupFailureReport({
        databaseCleanup: 'database_drop_deadline',
        beforeClose: undefined,
        owner: { error },
      }),
    ).toEqual(['database_drop_deadline', 'connection runtime (Error)']);
  });

  it("names the errors inside a runtime's own aggregate without their messages", async () => {
    const error = await ownerFailure([
      {
        name: 'identity runtime',
        error: new AggregateError(
          [new PoolClosedError(SECRET), new Error(SECRET)],
          SECRET,
        ),
      },
    ]);

    const report = cleanupFailureReport({
      databaseCleanup: undefined,
      beforeClose: undefined,
      owner: { error },
    });

    expect(report).toEqual([
      'identity runtime (AggregateError [PoolClosedError ERR_POOL_CLOSED; Error])',
    ]);
    expect(JSON.stringify(report)).not.toContain('s3cr3t');
  });

  it('describes a thrown value that is not an error by its type', () => {
    expect(
      cleanupFailureReport({
        databaseCleanup: undefined,
        beforeClose: { error: SECRET },
        owner: undefined,
      }),
    ).toEqual(['before close (non-error string)']);
  });
});
