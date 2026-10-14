import { z } from 'zod';

export const ARTIFACT_INPUT_CAPABILITY = 'artifact_input';
export const ARTIFACT_INPUT_MAX_BYTES = 1_048_576;

export const nodeArtifactReferenceSchema = z
  .object({
    artifactId: z.uuid(),
    byteLength: z
      .number()
      .int()
      .min(0)
      .max(5 * 1024 * 1024 * 1024),
    mediaType: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[^\s/;]+\/[^\r\n]+$/u)
      .regex(/^[\t\x20-\x7e\x80-\xff]+$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .readonly();

export type NodeArtifactReference = z.output<
  typeof nodeArtifactReferenceSchema
>;
