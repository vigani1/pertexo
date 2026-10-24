export interface RunArtifactRetentionStore {
  delete(input: {
    readonly artifactId: string;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<void>;
  head(input: {
    readonly artifactId: string;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<object | null>;
}

export type RunArtifactRetentionProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      artifactId: string;
      status: 'completed' | 'referenced' | 'waiting';
      workspaceId: string;
    }>;

export interface RunArtifactRetentionCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<RunArtifactRetentionProcessResult>;
}

export interface RunArtifactRetentionCoordinatorOptions {
  readonly externalOperationTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}
