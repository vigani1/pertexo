import { z } from 'zod';

/** Content identity, independent of executable checksums and draft preconditions. */
export const workflowGraphDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .describe(
    'Returned on reads with include=graphDigest. Review the source graph, then echo this content identity as reviewedGraphDigest; draft writes still require the opaque ETag.',
  );
