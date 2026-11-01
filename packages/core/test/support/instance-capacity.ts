import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { type InstanceCapacity } from '@pertexo/database/platform';
import { DEFAULT_INSTANCE_LIMITS } from '../../src/runs/instance-limits.js';

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
  afterAll(() => apply(DEFAULT_INSTANCE_LIMITS, connectionString));
}
