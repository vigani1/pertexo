export type PreviewRetentionProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      artifactId?: string;
      previewRunId: string;
      status: 'completed' | 'progressed' | 'waiting';
      workspaceId: string;
    }>;
