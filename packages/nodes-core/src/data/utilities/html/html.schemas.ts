import { z } from 'zod';
import { COLLECTION_MAX_ITEMS } from '../../lists/collection.schemas.js';

/** HTML extraction bounds; the parser and the selector check read them too. */
export const HTML_LIMITS = Object.freeze({
  selectorCharacters: 256,
  attributeCharacters: 128,
  defaultResults: 100,
  // Elements, attributes and text nodes one document may hold.
  nodes: 8_000,
  depth: 48,
  selectorGroups: 4,
  selectorTokens: 16,
});
const selectorSchema = z
  .string()
  .min(1)
  .max(HTML_LIMITS.selectorCharacters)
  .meta({ default: 'a' });
const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(COLLECTION_MAX_ITEMS)
  .meta({ default: HTML_LIMITS.defaultResults });
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
        attribute: z
          .string()
          .min(1)
          .max(HTML_LIMITS.attributeCharacters)
          .meta({ default: 'href' }),
        limit: limitSchema,
      })
      .strict(),
  ])
  .meta({
    description:
      'Extract text or an attribute with a simple CSS selector. Scripts never run and links are never fetched. Match count and Truncated show when your result limit was reached.',
    default: {
      operation: 'text',
      selector: 'a',
      limit: HTML_LIMITS.defaultResults,
    },
  });
export const htmlInputSchema = z.object({ value: z.string() }).strict();
export const htmlOutputSchema = z
  .object({
    items: z.array(z.string()).max(COLLECTION_MAX_ITEMS),
    matchCount: z.number().int().min(0).max(HTML_LIMITS.nodes),
    truncated: z.boolean(),
  })
  .strict();
export type HtmlConfig = z.output<typeof htmlConfigSchema>;
