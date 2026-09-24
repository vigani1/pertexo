import { z } from 'zod';

type ApplicationKey = Readonly<{ version: string; key: string }>;

/** Current sealing key plus the previous keys still accepted for opening. */
export type ApplicationKeyRing = Readonly<{
  current: ApplicationKey;
  previous: readonly ApplicationKey[];
}>;

export const applicationKeyVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u);

/**
 * Parses the optional JSON list of retired application keys. At most eight
 * previous keys stay readable so rotation cannot grow the ring unbounded.
 */
export function parseApplicationPreviousKeys(
  input: string | undefined,
): ApplicationKeyRing['previous'] {
  if (input === undefined) return Object.freeze([]);
  return Object.freeze(
    z
      .array(
        z
          .object({
            version: applicationKeyVersionSchema,
            key: z.string().min(1),
          })
          .strict(),
      )
      .max(8)
      .parse(JSON.parse(input) as unknown),
  );
}
