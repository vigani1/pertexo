import type {
  WorkflowTestPins,
  WorkflowTestPolicy,
} from '@pertexo/workflow-engine';

/** A published workflow version with the executable a run follows. */
export type PublishedWorkflow = Readonly<{
  checksum: string;
  executableJson: unknown;
  id: string;
  versionNumber: number;
  workflowId: string;
  workspaceId: string;
}>;

export type ReadPublishedWorkflowForExecutionInput = Readonly<{
  signal?: AbortSignal;
  workflowVersionId: string;
  workspaceId: string;
}>;

export interface PublishedWorkflowReader {
  /** The published version, or null when it is not visible. */
  readForExecution(
    input: ReadPublishedWorkflowForExecutionInput,
  ): Promise<PublishedWorkflow | null>;
  close(): Promise<void>;
}

export type WorkflowExecutionProjection = PublishedWorkflow &
  Readonly<{
    testExpiresAt?: Date;
    testSample?: WorkflowTestPins[string];
    test?: WorkflowTestPolicy;
  }>;

export interface WorkflowExecutionReader extends Omit<
  PublishedWorkflowReader,
  'readForExecution'
> {
  readForExecution(
    input: Parameters<PublishedWorkflowReader['readForExecution']>[0] &
      Readonly<{ nodeId?: string }>,
  ): Promise<WorkflowExecutionProjection | null>;
}
