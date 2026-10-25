import type { buildRunTimeline } from '@/features/workflow-runs/model/timeline/runs';
import type {
  WorkflowNodeRunSummary,
  WorkflowRunEvent,
  WorkflowRunSummary,
} from '@pertexo/contracts';
export const start = Date.parse('2026-09-24T14:31:00.000Z');

export function at(seconds: number): string {
  return new Date(start + seconds * 1_000).toISOString();
}

export function runSummary(
  status: WorkflowRunSummary['status'],
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status,
    triggerType: 'webhook',
    createdAt: at(0),
    updatedAt: at(0),
    startedAt: at(0),
    completedAt: null,
    deadlineAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

export function node(
  nodeId: string,
  status: WorkflowNodeRunSummary['status'],
  overrides: Partial<WorkflowNodeRunSummary> = {},
): WorkflowNodeRunSummary {
  return {
    id: `11111111-1111-4111-8111-11111111111${String(nodeId.length % 10)}`,
    nodeId,
    invocationKey: `${nodeId}:0`,
    status,
    currentAttemptNumber: 1,
    startedAt: at(1),
    completedAt: null,
    resumeAt: null,
    safeErrorCode: null,
    ...overrides,
  };
}

export const eventSequence = { value: 0 };

export function nodeEvent(
  type: WorkflowRunEvent['type'],
  seconds: number,
  payload: Partial<WorkflowRunEvent['payload']> = {},
): WorkflowRunEvent {
  eventSequence.value += 1;
  return {
    sequence: eventSequence.value,
    type,
    createdAt: at(seconds),
    payload: {
      nodeId: 'send-receipt',
      invocationKey: 'send-receipt:0',
      ...payload,
    },
  };
}

export const graph =
  /* This focused graph fixture supplies the node/edge metadata read by the presenter; executable-only fields are omitted. */ {
    nodes: [
      {
        id: 'post-erp',
        label: 'Post to ERP',
        definition: { key: 'http.request', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'send-receipt',
        label: 'Send receipt',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 200, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'done',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 400, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  } as unknown as NonNullable<Parameters<typeof buildRunTimeline>[0]['graph']>;

export const stop = (id: string, value: unknown) => ({
  id,
  inputMappings: { outcome: { kind: 'literal', value } },
});
