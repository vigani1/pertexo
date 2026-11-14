import { z } from 'zod';

const OUTPUT_VARIANT_LIMITS = Object.freeze({
  propertyCharacters: 128,
  // Output unions have at most 64 branches.
  lastVariant: 63,
  pathSegments: 8,
  overrides: 8,
});

/** Browser discovery: select one output-union branch from a config property's presence. */
export const outputVariantSelectionSchema = z
  .object({
    configProperty: z
      .string()
      .min(1)
      .max(OUTPUT_VARIANT_LIMITS.propertyCharacters),
    whenPresent: z.number().int().min(0).max(OUTPUT_VARIANT_LIMITS.lastVariant),
    whenAbsent: z.number().int().min(0).max(OUTPUT_VARIANT_LIMITS.lastVariant),
    overrides: z
      .array(
        z
          .object({
            configPath: z
              .array(
                z.string().min(1).max(OUTPUT_VARIANT_LIMITS.propertyCharacters),
              )
              .min(1)
              .max(OUTPUT_VARIANT_LIMITS.pathSegments)
              .readonly(),
            variant: z
              .number()
              .int()
              .min(0)
              .max(OUTPUT_VARIANT_LIMITS.lastVariant),
          })
          .strict()
          .readonly(),
      )
      .max(OUTPUT_VARIANT_LIMITS.overrides)
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type OutputVariantSelection = z.output<
  typeof outputVariantSelectionSchema
>;

/** Nested opt-in modes take precedence over the original presence selector. */
export function selectOutputVariant(
  selection: OutputVariantSelection,
  config: Readonly<Record<string, unknown>>,
): number {
  for (const override of selection.overrides ?? []) {
    let current: unknown = config;
    const present = override.configPath.every((key) => {
      if (!hasOwnConfigProperty(current, key)) return false;
      current = current[key];
      return true;
    });
    if (present) return override.variant;
  }
  return Object.hasOwn(config, selection.configProperty)
    ? selection.whenPresent
    : selection.whenAbsent;
}

function hasOwnConfigProperty(
  value: unknown,
  key: string,
): value is Readonly<Record<string, unknown>> {
  const readable =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key);
  return readable;
}
