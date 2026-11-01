export interface PreviewRetentionArtifactStore {
  delete(
    input: Readonly<{
      artifactId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<void>;
  head(
    input: Readonly<{
      artifactId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<object | null>;
}

export type PreviewRetentionProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      artifactId?: string;
      previewRunId: string;
      status: 'completed' | 'progressed' | 'waiting';
      workspaceId: string;
    }>;

export interface PreviewRetentionCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<PreviewRetentionProcessResult>;
}

export interface PreviewRetentionCoordinatorOptions {
  readonly artifactQuiescenceSeconds?: number;
  readonly externalOperationTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}
