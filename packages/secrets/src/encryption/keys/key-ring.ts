import { z } from 'zod';

export class ApplicationKeyConfigurationError extends TypeError {
  public override readonly name = 'ApplicationKeyConfigurationError';
  public constructor(
    public readonly section: 'current' | 'previous',
    message: string,
  ) {
    super(message);
  }
}

export const applicationKeyVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u);
const keySchema = z
  .object({ version: applicationKeyVersionSchema, key: z.string().min(1) })
  .strict();
export type ApplicationKey = Readonly<z.output<typeof keySchema>>;
export type ApplicationKeyRing = Readonly<{
  current: ApplicationKey;
  previous: readonly ApplicationKey[];
}>;

export function parseApplicationPreviousKeys(
  input: string | undefined,
): ApplicationKeyRing['previous'] {
  if (input === undefined) return Object.freeze([]);
  try {
    const keys = z
      .array(keySchema)
      .max(8)
      .parse(JSON.parse(input) as unknown);
    assertUniqueVersions(keys);
    return Object.freeze(keys.map((key) => Object.freeze(key)));
  } catch {
    throw new ApplicationKeyConfigurationError(
      'previous',
      'Previous application keys are invalid',
    );
  }
}

function assertUniqueVersions(keys: readonly ApplicationKey[]): void {
  const versions = new Set<string>();
  for (const entry of keys) {
    if (versions.has(entry.version))
      throw new ApplicationKeyConfigurationError(
        'previous',
        'Application key versions must be unique',
      );
    versions.add(entry.version);
  }
}

export function decodeApplicationKey(encoded: string): Buffer {
  const normalized = encoded
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  const key = Buffer.from(normalized, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== normalized) {
    key.fill(0);
    throw new TypeError('Application secret key must encode exactly 32 bytes');
  }
  return key;
}

export function validateApplicationKeyRing(
  config: Readonly<{
    current: ApplicationKey;
    previous?: readonly ApplicationKey[];
  }>,
): ApplicationKeyRing {
  const parsed = z
    .object({
      current: keySchema,
      previous: z.array(keySchema).max(8).default([]),
    })
    .strict()
    .safeParse(config);
  if (!parsed.success)
    throw new ApplicationKeyConfigurationError(
      parsed.error.issues[0]?.path[0] === 'previous' ? 'previous' : 'current',
      'Application key ring is invalid',
    );
  const entries = [parsed.data.current, ...parsed.data.previous];
  assertUniqueVersions(entries);
  for (const [index, entry] of entries.entries()) {
    try {
      decodeApplicationKey(entry.key).fill(0);
    } catch {
      throw new ApplicationKeyConfigurationError(
        index === 0 ? 'current' : 'previous',
        'Application secret key must encode exactly 32 bytes',
      );
    }
  }
  return Object.freeze({
    current: Object.freeze(parsed.data.current),
    previous: Object.freeze(
      parsed.data.previous.map((entry) => Object.freeze(entry)),
    ),
  });
}
