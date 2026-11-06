import { z } from 'zod';

/** Untagged digests are legacy v1; only v2 is emitted for new executables. */
export const workflowExecutableChecksumSchema = z
  .string()
  .regex(/^wf:sha256:(?:v2:)?[a-f0-9]{64}$/u);
