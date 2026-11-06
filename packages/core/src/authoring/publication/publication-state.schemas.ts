import { workflowExecutableChecksumSchema } from '@pertexo/workflow-model';
import { z } from 'zod';

export const executableSchema = z
  .object({
    checksum: workflowExecutableChecksumSchema,
    executableJson: z.record(z.string(), z.unknown()),
  })
  .strict();

/** A retry gets back the version its first attempt published. */
export const publicationReceipt = z.object({
  versionId: z.uuid(),
  reused: z.boolean(),
});
