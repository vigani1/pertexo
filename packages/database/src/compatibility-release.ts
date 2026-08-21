import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { WorkspaceDrizzle } from './workspace.js';

const MAXIMUM_COMPATIBILITY_CATALOG_BYTES = 128 * 1024;
const fingerprintSchema = z
  .string()
  .regex(/^node-compat:v1:sha256:[0-9a-f]{64}$/u);
const expectationSchema = z
  .object({
    epoch: z.number().int().positive(),
    fingerprint: fingerprintSchema,
    catalogJson: z.string().min(1),
  })
  .strict();

export type CompatibilityReleaseExpectation = Readonly<{
  epoch: number;
  fingerprint: string;
  /** Canonical compatibility-release projection owned by node-sdk. */
  catalogJson: string;
}>;

export class CompatibilityReleaseMismatchError extends Error {
  public override readonly name = 'CompatibilityReleaseMismatchError';

  public constructor() {
    super('Node compatibility release does not match this artifact');
  }
}

export function parseCompatibilityReleaseExpectation(
  input: unknown,
): CompatibilityReleaseExpectation {
  const parsed = expectationSchema.parse(input);
  if (
    Buffer.byteLength(parsed.catalogJson, 'utf8') >
    MAXIMUM_COMPATIBILITY_CATALOG_BYTES
  ) {
    throw new TypeError('Compatibility release catalog is too large');
  }
  let catalog: unknown;
  try {
    catalog = JSON.parse(parsed.catalogJson) as unknown;
  } catch {
    throw new TypeError('Compatibility release catalog is not JSON');
  }
  if (
    catalog === null ||
    typeof catalog !== 'object' ||
    Array.isArray(catalog) ||
    Object.getPrototypeOf(catalog) !== Object.prototype
  ) {
    throw new TypeError('Compatibility release catalog is not an object');
  }
  const record = catalog as Record<string, unknown>;
  if (
    record.domain !== 'pertexo.node-compatibility-release' ||
    record.schemaVersion !== 1 ||
    JSON.stringify(catalog) !== parsed.catalogJson
  ) {
    throw new TypeError('Compatibility release catalog is not canonical V1');
  }
  return Object.freeze({ ...parsed });
}

export async function lockExpectedCompatibilityRelease(
  database: WorkspaceDrizzle,
  input: CompatibilityReleaseExpectation,
): Promise<void> {
  const expected = parseCompatibilityReleaseExpectation(input);
  try {
    const result = await database.execute(sql`
      select epoch, fingerprint, catalog_json
      from app.lock_node_compatibility_current(
        ${expected.epoch},
        ${expected.fingerprint},
        ${expected.catalogJson}::jsonb
      )
    `);
    if (result.rows.length !== 1) throw new CompatibilityReleaseMismatchError();
  } catch (error: unknown) {
    if (error instanceof CompatibilityReleaseMismatchError) throw error;
    throw new CompatibilityReleaseMismatchError();
  }
}

export async function checkExpectedCompatibilityRelease(
  pool: Pool,
  input: CompatibilityReleaseExpectation,
): Promise<void> {
  await lockExpectedCompatibilityReleaseWithClient(pool, input);
}

export async function lockExpectedCompatibilityReleaseWithClient(
  client: Pick<Pool | PoolClient, 'query'>,
  input: CompatibilityReleaseExpectation,
): Promise<void> {
  const expected = parseCompatibilityReleaseExpectation(input);
  try {
    const result = await client.query(
      `select epoch, fingerprint, catalog_json
         from app.lock_node_compatibility_current($1, $2, $3::jsonb)`,
      [expected.epoch, expected.fingerprint, expected.catalogJson],
    );
    if (result.rows.length !== 1) throw new CompatibilityReleaseMismatchError();
  } catch (error: unknown) {
    if (error instanceof CompatibilityReleaseMismatchError) throw error;
    throw new CompatibilityReleaseMismatchError();
  }
}
