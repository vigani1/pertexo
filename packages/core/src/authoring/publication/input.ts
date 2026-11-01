import { z } from 'zod';

const uuidSchema = z.uuid();

export const executableSchema = z
  .object({
    checksum: z.string().regex(/^wf:sha256:[0-9a-f]{64}$/u),
    executableJson: z.record(z.string(), z.unknown()),
  })
  .strict();

/** A retry gets back the version its first attempt published. */
export const storedPublicationSchema = z
  .object({ versionId: uuidSchema, reused: z.boolean() })
  .strict();
