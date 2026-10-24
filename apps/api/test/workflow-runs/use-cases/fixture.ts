import { runPersistenceSpies } from '../../support/run-ports.js';
import type { Role } from '@pertexo/workflow-model';

import { vi } from 'vitest';
import { createActorContext } from '../../../src/authorization/index.js';
import {
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  type ReplayWorkflowRunInput,
  type StartWorkflowRunInput,
} from '../../../src/workflow-runs/use-cases.js';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const workflowVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const now = new Date('2026-08-21T12:00:00.000Z');

export const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'request-42',
  traceId: 'trace-42',
});

export function authorization(role: Role = 'owner') {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

export function run() {
  return {
    id: runId,
    workspaceId,
    workflowId,
    workflowVersionId,
    status: 'queued' as const,
    triggerType: 'manual' as const,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

export function persistence() {
  const store = runPersistenceSpies();
  store.start.mockResolvedValue({ run: run(), replayed: false });
  store.replay.mockResolvedValue({ run: run(), replayed: false });
  store.get.mockResolvedValue({ run: run(), nodes: [] });
  store.list.mockResolvedValue({ items: [run()] });
  store.cancel.mockResolvedValue({ run: run(), alreadyRequested: false });
  store.readInput.mockResolvedValue({ kind: 'expired' });
  store.readNodeRunOutput.mockResolvedValue(undefined);
  return { store, ...store };
}

function accessFor(selectedActorId: string, selectedWorkspaceId: string) {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId: selectedActorId,
      workspaceId: selectedWorkspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

export async function startCommand(
  overrides: Partial<StartWorkflowRunInput> = {},
) {
  const input: StartWorkflowRunInput = {
    actor,
    routeWorkspaceId: workspaceId,
    workflowId,
    idempotencyKey: 'stable-start-key',
    ...overrides,
  };
  const fixture = persistence();
  await new StartWorkflowRunUseCase(
    fixture.store,
    accessFor(input.actor.actorId, input.routeWorkspaceId),
  ).execute(input);
  const command = fixture.start.mock.calls[0]?.[0];
  if (command === undefined) throw new Error('start command was not persisted');
  return command;
}

export async function replayCommand(
  overrides: Partial<ReplayWorkflowRunInput> = {},
) {
  const input: ReplayWorkflowRunInput = {
    actor,
    routeWorkspaceId: workspaceId,
    runId,
    workflowVersionId,
    idempotencyKey: 'stable-replay-key',
    input: { a: 1, b: 2 },
    ...overrides,
  };
  const fixture = persistence();
  await new ReplayWorkflowRunUseCase(
    fixture.store,
    accessFor(input.actor.actorId, input.routeWorkspaceId),
  ).execute(input);
  const command = fixture.replay.mock.calls[0]?.[0];
  if (command === undefined)
    throw new Error('replay command was not persisted');
  return command;
}
