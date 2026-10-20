import { z } from 'zod';

const common = {
  locale: z.enum(['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP']),
  grouping: z.boolean(),
  minimumFractionDigits: z.number().int().min(0).max(20),
  maximumFractionDigits: z.number().int().min(0).max(20),
};
export const numberConfigSchema = z
  .discriminatedUnion('operation', [
    z.object({ operation: z.literal('decimal'), ...common }).strict(),
    z.object({ operation: z.literal('percent'), ...common }).strict(),
    z
      .object({
        operation: z.literal('currency'),
        ...common,
        currency: z
          .string()
          .length(3)
          .regex(/^[A-Z]{3}$/u),
      })
      .strict(),
  ])
  .refine(
    (c) => c.minimumFractionDigits <= c.maximumFractionDigits,
    'Minimum fraction digits cannot exceed maximum',
  );
export const numberInputSchema = z.object({ value: z.number() }).strict();
export const numberOutputSchema = z.object({ value: z.string() }).strict();
export type NumberConfig = z.output<typeof numberConfigSchema>;
