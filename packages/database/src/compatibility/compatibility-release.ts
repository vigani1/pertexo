import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { WorkspaceDrizzle } from '../tenant-access/workspace.js';

const MAXIMUM_COMPATIBILITY_CATALOG_BYTES = 128 * 1024;
const MAXIMUM_ROLLING_RELEASES = 2;
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

export type CompatibilityReleaseExpectationSet =
  readonly CompatibilityReleaseExpectation[];

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

export function parseCompatibilityReleaseExpectationSet(
  input: unknown,
): CompatibilityReleaseExpectationSet {
  const releases = parseCompatibilityReleaseExpectationHistory(input);
  if (releases.length > MAXIMUM_ROLLING_RELEASES)
    throw new TypeError('Compatibility readiness supports one rolling overlap');
  return releases;
}

export function parseCompatibilityReleaseExpectationHistory(
  input: unknown,
): CompatibilityReleaseExpectationSet {
  const releases = z
    .array(z.unknown())
    .min(1)
    .parse(input)
    .map(parseCompatibilityReleaseExpectation);
  const identities = releases.map(
    ({ epoch, fingerprint }) => `${String(epoch)}\u0000${fingerprint}`,
  );
  if (new Set(identities).size !== identities.length)
    throw new TypeError('Compatibility release expectations must be unique');
  return Object.freeze(releases);
}

function expectedSetJson(
  expectations: CompatibilityReleaseExpectationSet,
): string {
  return JSON.stringify(
    expectations.map(({ epoch, fingerprint, catalogJson }) => ({
      epoch,
      fingerprint,
      catalog: JSON.parse(catalogJson) as unknown,
    })),
  );
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

export async function checkExpectedCompatibilityReleaseSet(
  pool: Pool,
  input: CompatibilityReleaseExpectationSet,
): Promise<void> {
  await lockExpectedCompatibilityReleaseSetWithClient(pool, input);
}

function matchedExpectation(
  expected: CompatibilityReleaseExpectationSet,
  row: unknown,
): CompatibilityReleaseExpectation {
  const parsed = z
    .object({
      epoch: z.coerce.number().int().positive(),
      fingerprint: fingerprintSchema,
      catalog_json: z.unknown(),
    })
    .loose()
    .parse(row);
  const matched = expected.find(
    (release) =>
      release.epoch === parsed.epoch &&
      release.fingerprint === parsed.fingerprint,
  );
  if (matched === undefined) throw new CompatibilityReleaseMismatchError();
  return matched;
}

export async function lockExpectedCompatibilityReleaseSet(
  database: WorkspaceDrizzle,
  input: CompatibilityReleaseExpectationSet,
): Promise<CompatibilityReleaseExpectation> {
  const expected = parseCompatibilityReleaseExpectationSet(input);
  try {
    const result = await database.execute(sql`
      select epoch, fingerprint, catalog_json
      from app.lock_node_compatibility_current_supported(
        ${expectedSetJson(expected)}::jsonb
      )
    `);
    if (result.rows.length !== 1) throw new CompatibilityReleaseMismatchError();
    return matchedExpectation(expected, result.rows[0]);
  } catch (error: unknown) {
    if (error instanceof CompatibilityReleaseMismatchError) throw error;
    throw new CompatibilityReleaseMismatchError();
  }
}

export async function lockExpectedCompatibilityReleaseSetWithClient(
  client: Pick<Pool | PoolClient, 'query'>,
  input: CompatibilityReleaseExpectationSet,
): Promise<CompatibilityReleaseExpectation> {
  const expected = parseCompatibilityReleaseExpectationSet(input);
  try {
    const result = await client.query(
      `select epoch, fingerprint, catalog_json
         from app.lock_node_compatibility_current_supported($1::jsonb)`,
      [expectedSetJson(expected)],
    );
    if (result.rows.length !== 1) throw new CompatibilityReleaseMismatchError();
    return matchedExpectation(expected, result.rows[0]);
  } catch (error: unknown) {
    if (error instanceof CompatibilityReleaseMismatchError) throw error;
    throw new CompatibilityReleaseMismatchError();
  }
}

export async function checkCompatibilityReleasePreactivationTarget(
  pool: Pool,
  supportedInput: CompatibilityReleaseExpectationSet,
  targetInput: CompatibilityReleaseExpectation,
): Promise<void> {
  const supported = parseCompatibilityReleaseExpectationSet(supportedInput);
  const target = parseCompatibilityReleaseExpectation(targetInput);
  if (
    !supported.some(
      (release) =>
        release.epoch === target.epoch &&
        release.fingerprint === target.fingerprint &&
        release.catalogJson === target.catalogJson,
    )
  )
    throw new CompatibilityReleaseMismatchError();
  try {
    const result = await pool.query(
      `select epoch, fingerprint
         from app.node_compatibility_releases
        where epoch = $1
          and fingerprint = $2
          and catalog_json = $3::jsonb
        `,
      [target.epoch, target.fingerprint, target.catalogJson],
    );
    if (result.rows.length !== 1) throw new CompatibilityReleaseMismatchError();
  } catch (error: unknown) {
    if (error instanceof CompatibilityReleaseMismatchError) throw error;
    throw new CompatibilityReleaseMismatchError();
  }
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
