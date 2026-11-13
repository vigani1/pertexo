import { z } from 'zod';
import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/semantics.schemas.js';

const selectorSchema = z.string().min(1).max(256).meta({ default: 'a' });
const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(COLLECTION_MAX_ITEMS)
  .meta({ default: 100 });
export const htmlConfigSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        operation: z.literal('text').meta({ title: 'Extract text' }),
        selector: selectorSchema,
        limit: limitSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('attribute').meta({ title: 'Extract attribute' }),
        selector: selectorSchema,
        attribute: z.string().min(1).max(128).meta({ default: 'href' }),
        limit: limitSchema,
      })
      .strict(),
  ])
  .meta({
    description:
      'Extract text or an attribute with a simple CSS selector. Scripts never run and links are never fetched. Match count and Truncated show when your result limit was reached.',
    default: { operation: 'text', selector: 'a', limit: 100 },
  });
export const htmlInputSchema = z.object({ value: z.string() }).strict();
export const htmlOutputSchema = z
  .object({
    items: z.array(z.string()).max(COLLECTION_MAX_ITEMS),
    matchCount: z.number().int().min(0).max(8_000),
    truncated: z.boolean(),
  })
  .strict();
export type HtmlConfig = z.output<typeof htmlConfigSchema>;
