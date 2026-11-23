import { z } from 'zod';

export const CONFORMANCE_FILE = 'conformance.json';
export const SYNTHETIC_CREDENTIAL_PREFIX = 'fixture-';

const headers = z.record(z.string().regex(/^[a-z0-9-]+$/u), z.string());

export const conformanceExamples = z
  .array(
    z.strictObject({
      operation: z.string().min(1),
      input: z.record(z.string(), z.json()),
      request: z.strictObject({
        method: z.string(),
        path: z.string().startsWith('/'),
        headers,
        body: z.json().optional(),
      }),
      response: z.strictObject({
        status: z.number().int().min(200).max(599),
        body: z.json().optional(),
      }),
      output: z.json(),
    }),
  )
  .min(1);

export type ConformanceExample = z.output<typeof conformanceExamples>[number];
