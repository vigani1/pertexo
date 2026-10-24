import { z } from 'zod';

export const configSchema = z
  .object({
    workerUrl: z.string(),
    dispatcherUrl: z.string(),
    apiUrl: z.string(),
    migrationUrl: z.string(),
    connectionMasterKey: z.string().regex(/^[a-f0-9]{64}$/u),
    controlOrigin: z.url(),
  })
  .strict();
