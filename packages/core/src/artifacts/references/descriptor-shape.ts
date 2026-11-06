import { nodeArtifactReferenceSchema } from '@pertexo/node-sdk';

const descriptorKind = 'artifact';
const descriptorKeys = nodeArtifactReferenceSchema.unwrap().keyof();
const descriptorFields = descriptorKeys.options;
const artifactIdField = descriptorKeys.extract(['artifactId']).enum.artifactId;

// A necessary condition also covers legacy execution values with only kind and ID.
export const ARTIFACT_REFERENCE_PRESENCE_JSON_PATH = `lax $.** ? (@.kind.type() == "string" && @.kind == ${JSON.stringify(descriptorKind)} && exists(@.${artifactIdField}))`;

// Admission and raw-owner discovery distinguish file descriptors from business JSON.
export const ARTIFACT_DESCRIPTOR_JSON_PATH = `lax $.** ? (@.kind.type() == "string" && @.kind == ${JSON.stringify(descriptorKind)} && ${descriptorFields.map((field) => `exists(@.${field})`).join(' && ')}).artifactId`;

export function isArtifactDescriptor(value: Record<string, unknown>): boolean {
  return (
    value.kind === descriptorKind &&
    descriptorFields.every((field) => field in value)
  );
}
