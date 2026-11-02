export type ErrorWorkflowDeliveryInput = Readonly<{
  workspaceId: string;
  sourceRunId: string;
  outboxEventId: string;
  payloadChecksum: string;
  signal: AbortSignal;
  traceparent?: string | undefined;
}>;

export interface ErrorWorkflowStore {
  dispatch(input: ErrorWorkflowDeliveryInput): Promise<void>;
  close(): Promise<void>;
}
