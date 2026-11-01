import type { PoolClient } from 'pg';

import type { PendingCoordinatorFailure } from '../load/state.queries.js';

import type { RunTransitionPlan } from '../plan.js';

import type { CoordinatorExecutionIdentity } from './admissions/contract.js';
import { persistPendingFailureDecisions } from './admissions/failure-decisions.repository.js';
import {
  persistNodeAdmissions,
  persistAttemptAdmissions,
} from './admissions/create-executions.repository.js';
import {
  loadEventExecutionIdentities,
  persistRunEvents,
} from './admissions/events.repository.js';
export async function persistCoordinatorExecutionTransitions(
  client: PoolClient,
  input: Readonly<{
    pendingFailures: readonly PendingCoordinatorFailure[];
    plan: RunTransitionPlan;
    runId: string;
    traceparent?: string;
    workspaceId: string;
    rejectedForEachDeclarations: ReadonlySet<string>;
  }>,
): Promise<ReadonlyMap<string, CoordinatorExecutionIdentity>> {
  const { pendingFailures, plan, runId, traceparent, workspaceId } = input;
  await persistPendingFailureDecisions(client, plan, {
    pendingFailures,
    workspaceId,
    runId,
  });
  const physical = await persistNodeAdmissions(
    client,
    plan,
    workspaceId,
    runId,
  );
  await persistAttemptAdmissions(client, {
    physical,
    plan,
    runId,
    ...(traceparent === undefined ? {} : { traceparent }),
    workspaceId,
  });
  await loadEventExecutionIdentities(client, physical, {
    plan,
    workspaceId,
    runId,
  });
  await persistRunEvents(client, {
    pendingFailures,
    physical,
    plan,
    runId,
    workspaceId,
    rejectedForEachDeclarations: input.rejectedForEachDeclarations,
  });
  return physical;
}
