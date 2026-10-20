import { z } from 'zod';

/** Browser discovery: select one output-union branch from a config property's presence. */
export const outputVariantSelectionSchema = z
  .object({
    configProperty: z.string().min(1).max(128),
    whenPresent: z.number().int().min(0).max(63),
    whenAbsent: z.number().int().min(0).max(63),
  })
  .strict()
  .readonly();
export type OutputVariantSelection = z.output<
  typeof outputVariantSelectionSchema
>;
