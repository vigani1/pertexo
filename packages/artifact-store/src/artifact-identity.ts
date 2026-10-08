import { z } from 'zod';

export interface ArtifactIdentity {
  readonly artifactId: string;
  readonly workspaceId: string;
}

export const artifactIdentitySchema = z.object({
  artifactId: z.uuid(),
  workspaceId: z.uuid(),
});

/** Durable artifact byte identity. */
export function artifactStorageKey(identity: ArtifactIdentity): string {
  return `workspaces/${identity.workspaceId}/artifacts/${identity.artifactId}`;
}
