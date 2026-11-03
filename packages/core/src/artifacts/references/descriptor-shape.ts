import { nodeArtifactReferenceSchema } from '@pertexo/node-sdk';

const descriptorKind = 'artifact';
const descriptorFields = nodeArtifactReferenceSchema.unwrap().keyof().options;

// Admission and raw-owner discovery distinguish file descriptors from business JSON.
export const ARTIFACT_DESCRIPTOR_JSON_PATH = `lax $.** ? (@.kind == ${JSON.stringify(descriptorKind)} && ${descriptorFields.map((field) => `exists(@.${field})`).join(' && ')}).artifactId`;

export function isArtifactDescriptor(value: Record<string, unknown>): boolean {
  return (
    value.kind === descriptorKind &&
    descriptorFields.every((field) => field in value)
  );
}
