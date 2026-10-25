export interface ErrorWorkflowDeliveryInput {
  workspaceId: string;
  sourceRunId: string;
  outboxEventId: string;
  payloadChecksum: string;
  signal: AbortSignal;
  traceparent?: string | undefined;
}
