import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

export interface Q11DatabaseIdentity {
  readonly applicationName: string;
  readonly database: string;
  readonly role: string;
}

export async function waitForQ11OverlapBarrier(): Promise<void> {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const directory = process.env.PERTEXO_Q11_OVERLAP_DIRECTORY;
  const participant = process.env.PERTEXO_Q11_OVERLAP_PARTICIPANT;
  if (directory === undefined && participant === undefined) return;
  if (
    directory === undefined ||
    participant === undefined ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(participant)
  )
    throw new Error('Q11 overlap barrier configuration is incomplete');
  await writeFile(path.join(directory, `${participant}.ready`), '', {
    flag: 'wx',
  });
  const release = path.join(directory, 'release');
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await access(release);
      return;
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for the Q11 overlap release');
    await delay(10);
  }
}

export function recordQ11Operation(
  name: string,
  startedAt: number,
  population: number,
  boundary: string,
  databaseIdentity?: Q11DatabaseIdentity,
): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION_V2=${JSON.stringify({ schemaVersion: 2, name, startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population, boundary, databaseIdentity })}\n`,
  );
}

export async function readQ11DatabaseIdentity(
  connectionString: string,
): Promise<Q11DatabaseIdentity | undefined> {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return undefined;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{
      application_name: string;
      database: string;
      role: string;
    }>(
      `select current_database() database,current_user role,
              current_setting('application_name') application_name`,
    );
    const identity = result.rows[0];
    if (identity === undefined)
      throw new Error('Q11 database identity is missing');
    return {
      applicationName: identity.application_name,
      database: identity.database,
      role: identity.role,
    };
  } finally {
    await pool.end();
  }
}
