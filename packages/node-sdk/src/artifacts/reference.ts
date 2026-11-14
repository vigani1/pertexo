import { z } from 'zod';

export const ARTIFACT_INPUT_CAPABILITY = 'artifact_input';
export const ARTIFACT_INPUT_MAX_BYTES = 1_048_576;
/** Bounds every artifact reference carries, wherever it is written down. */
export const ARTIFACT_REFERENCE_LIMITS = Object.freeze({
  // The artifact store's largest object.
  maxBytes: 5 * 1024 * 1024 * 1024,
  // `a/b` is the shortest media type.
  minimumMediaTypeCharacters: 3,
  mediaTypeCharacters: 255,
});

export const nodeArtifactReferenceSchema = z
  .object({
    artifactId: z.uuid(),
    byteLength: z.number().int().min(0).max(ARTIFACT_REFERENCE_LIMITS.maxBytes),
    mediaType: z
      .string()
      .min(ARTIFACT_REFERENCE_LIMITS.minimumMediaTypeCharacters)
      .max(ARTIFACT_REFERENCE_LIMITS.mediaTypeCharacters)
      .regex(/^[^\s/;]+\/[^\r\n]+$/u)
      .regex(/^[\t\x20-\x7e\x80-\xff]+$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .readonly();

export type NodeArtifactReference = z.output<
  typeof nodeArtifactReferenceSchema
>;
