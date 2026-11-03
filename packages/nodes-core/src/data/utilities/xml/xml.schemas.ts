import { z } from 'zod';

export const XML_LIMITS = Object.freeze({ depth: 48, members: 8_000 });
export const xmlConfigSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('parse') }).strict(),
  z.object({ operation: z.literal('build') }).strict(),
]);
export const xmlInputSchema = z.object({ value: z.json() }).strict();
export const xmlOutputSchema = z.object({ value: z.json() }).strict();
export type XmlConfig = z.output<typeof xmlConfigSchema>;
