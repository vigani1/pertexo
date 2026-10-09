import { createHash } from 'node:crypto';

import { canonicalJson } from '@pertexo/workflow-model';

import type {
  ReplayWorkflowRunInput,
  StartWorkflowRunInput,
} from './use-cases.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function startRequestHash(input: StartWorkflowRunInput): string {
  return sha256(
    canonicalJson({
      domain: 'pertexo.workflow-run.start-request',
      version: 1,
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      ...(input.expectedPublishedVersionId === undefined
        ? {}
        : { expectedPublishedVersionId: input.expectedPublishedVersionId }),
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    }),
  );
}

export function replayRequestHash(input: ReplayWorkflowRunInput): string {
  return sha256(
    canonicalJson({
      domain: 'pertexo.workflow-run.replay-request',
      version: 1,
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      sourceRunId: input.runId,
      workflowVersionId: input.workflowVersionId,
      input: input.input,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    }),
  );
}
