import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import type { InstanceCapacity } from '@pertexo/database/platform';
import { DEFAULT_RUN_CAPACITY_LIMITS } from '../../src/runs/run-capacity-limits.js';
import { DEFAULT_ARTIFACT_COUNT_LIMIT } from '../../src/artifacts/artifact-limits.js';

async function apply(
  { activeRunLimit, queuedRunLimit, artifactCountLimit }: InstanceCapacity,
  connectionString: string,
) {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query('select app.apply_instance_capacity($1,$2,$3)', [
      activeRunLimit,
      queuedRunLimit,
      artifactCountLimit,
    ]);
  } finally {
    await pool.end();
  }
}

/** Runs a suite at limits small enough to reach, as an operator would set them. */
export function useInstanceCapacity(
  limits: InstanceCapacity,
  connectionString: string,
): void {
  beforeAll(() => apply(limits, connectionString));
  afterAll(() =>
    apply(
      {
        ...DEFAULT_RUN_CAPACITY_LIMITS,
        artifactCountLimit: DEFAULT_ARTIFACT_COUNT_LIMIT,
      },
      connectionString,
    ),
  );
}
