import { z } from 'zod';

export const executableSchema = z
  .object({
    checksum: z.string().regex(/^wf:sha256:[0-9a-f]{64}$/u),
    executableJson: z.record(z.string(), z.unknown()),
  })
  .strict();
