import { z } from 'zod';

const common = {
  locale: z
    .enum(['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'])
    .meta({ default: 'en-US' }),
  grouping: z.boolean().meta({ default: true }),
  minimumFractionDigits: z.number().int().min(0).max(20).meta({ default: 0 }),
  maximumFractionDigits: z.number().int().min(0).max(20).meta({ default: 2 }),
};
export const numberConfigSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        operation: z.literal('decimal').meta({ title: 'Decimal' }),
        ...common,
      })
      .strict(),
    z
      .object({
        operation: z.literal('percent').meta({ title: 'Percent' }),
        ...common,
      })
      .strict(),
    z
      .object({
        operation: z.literal('currency').meta({ title: 'Currency' }),
        ...common,
        currency: z
          .string()
          .length(3)
          .regex(/^[A-Z]{3}$/u)
          .meta({ default: 'USD' }),
      })
      .strict(),
  ])
  .refine(
    (c) => c.minimumFractionDigits <= c.maximumFractionDigits,
    'Minimum fraction digits cannot exceed maximum',
  )
  .meta({
    description:
      'Map a number in Inputs. Percent formats 0.25 as 25%. Currency formats the value without converting it.',
    default: {
      operation: 'decimal',
      locale: 'en-US',
      grouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    },
  });
export const numberInputSchema = z.object({ value: z.number() }).strict();
export const numberOutputSchema = z.object({ value: z.string() }).strict();
export type NumberConfig = z.output<typeof numberConfigSchema>;
