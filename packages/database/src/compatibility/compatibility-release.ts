import { z } from 'zod';

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
    throw new TypeError(
      'Compatibility release catalog is not a compact V1 authority expectation',
    );
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

/** The newest release in the set: the one this build serves. */
export function selectServingCompatibilityRelease(
  releases: CompatibilityReleaseExpectationSet,
): CompatibilityReleaseExpectation {
  const serving = releases.at(-1);
  if (serving === undefined)
    throw new TypeError('Compatibility release set is empty');
  return serving;
}
