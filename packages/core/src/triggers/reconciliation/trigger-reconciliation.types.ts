import type { WebhookAuthentication } from '@pertexo/contracts';
import type { WorkflowTriggerStatus } from '@pertexo/workflow-model';

export type WorkflowTriggerHealth = Readonly<{
  id: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  kind: 'webhook' | 'schedule';
  status: WorkflowTriggerStatus;
  healthStatus: 'pending' | 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
  lastErrorCode: string | null;
  endpointReady: boolean;
  authentication?: WebhookAuthentication;
  reconciledAt: Date | null;
}>;

export type ReconcileWorkflowTriggersInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  publishedVersionId: string;
  outboxEventId: string;
  delivery?: Readonly<{
    outboxEventId: string;
    payloadChecksum: string;
  }>;
}>;

export type RecordReconciliationFailureInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  publishedVersionId: string;
  reason: string;
}>;

export type WorkflowTriggerProjection = Readonly<{
  nodeId: string;
  kind: 'schedule' | 'webhook';
  config: Readonly<Record<string, unknown>>;
  configFingerprint: string;
}>;
