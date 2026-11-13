import { z } from 'zod';

export const XML_LIMITS = Object.freeze({ depth: 48, members: 8_000 });
export const xmlConfigSchema = z
  .discriminatedUnion('operation', [
    z
      .object({ operation: z.literal('parse').meta({ title: 'XML to JSON' }) })
      .strict(),
    z
      .object({ operation: z.literal('build').meta({ title: 'JSON to XML' }) })
      .strict(),
  ])
  .meta({
    description:
      'Convert data, not document formatting. XML attributes use @_ and text uses #text. DTDs are not supported.',
    default: { operation: 'parse' },
  });
export const xmlInputSchema = z.object({ value: z.json() }).strict();
export const xmlOutputSchema = z.object({ value: z.json() }).strict();
export type XmlConfig = z.output<typeof xmlConfigSchema>;
