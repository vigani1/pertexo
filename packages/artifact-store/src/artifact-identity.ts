import { z } from 'zod';

export interface ArtifactIdentity {
  readonly artifactId: string;
  readonly workspaceId: string;
}

export const artifactIdentitySchema = z.object({
  artifactId: z.uuid(),
  workspaceId: z.uuid(),
});

/** Every object of a workspace lives under this prefix; purge relies on it. */
export function workspacePrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/`;
}

/** Durable artifact byte identity. */
export function artifactStorageKey(identity: ArtifactIdentity): string {
  return `${workspacePrefix(identity.workspaceId)}artifacts/${identity.artifactId}`;
}
