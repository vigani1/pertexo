import type { acceptWorkflowRun } from '@pertexo/core/testing';

import type { Queue } from 'bullmq';
import type { QueueProducer } from '@pertexo/queue';

import type { withTenantAccept } from './accept.js';
import type { previewState } from './queries.js';

export interface AcceptedDelivery {
  accepted: Awaited<ReturnType<typeof withTenantAccept>>;
  job: {
    data: {
      outboxEventId: string;
      previewAttemptId: string;
      previewRunId: string;
      traceparent: string;
      workspaceId: string;
    };
    name: 'execute-preview-attempt';
  };
}

export type PreviewRuntimeReady = Readonly<{
  consumer: Readonly<{
    waitUntilReady(timeoutMillis: number): Promise<void>;
  }>;
}>;

export type PublishedPreviewDelivery = Readonly<{
  job: Awaited<ReturnType<QueueProducer['publish']>>;
  producer: QueueProducer;
  queue: Queue;
  state: Awaited<ReturnType<typeof previewState>>;
}>;

export interface AcceptedWorkflowDelivery {
  accepted: Awaited<ReturnType<typeof acceptWorkflowRun>>;
  job: {
    data: {
      outboxEventId: string;
      runId: string;
      traceparent: string;
      workspaceId: string;
    };
    name: 'advance-workflow-run';
  };
}
