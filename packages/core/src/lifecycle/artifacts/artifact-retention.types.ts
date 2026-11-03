export type RunArtifactRetentionProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      artifactId: string;
      status: 'completed' | 'referenced' | 'waiting';
      workspaceId: string;
    }>;
