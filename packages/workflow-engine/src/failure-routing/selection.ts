import { isSelectedFailureScope, isCompletedFailureHandler } from './scope.js';
import type { WorkflowNodeFailureValue } from '@pertexo/workflow-model';
import { WorkflowEngineError } from '../errors.js';
import type { InvocationState } from '../types.js';
import { invocationKey } from '../transition/scheduling/loops.js';
import {
  transitionEvent,
  type MutableWorkflowTransition,
} from '../transition/state.js';

export function selectFailureHandler(
  state: MutableWorkflowTransition,
  source: InvocationState,
  failure: WorkflowNodeFailureValue,
  occurredAt: string,
): void {
  if (state.cancelRequested || state.deadlineExpired) return;
  const route = state.graph?.failureRoutes?.find(
    ({ sourceNodeId }) => sourceNodeId === source.nodeId,
  );
  if (route === undefined) return;
  if (
    !isSelectedFailureScope(
      source,
      state.current.workflowVersionId,
      state.invocations,
      state.branchSelections,
    )
  )
    throw new WorkflowEngineError(
      'observation_invalid',
      'failure source is not in its executed choice scope',
    );
  if (
    failure.invocationKey !== source.invocationKey ||
    failure.nodeId !== source.nodeId ||
    failure.attemptNumber !== source.attemptNumber
  )
    throw new WorkflowEngineError(
      'observation_invalid',
      'failure evidence disagrees with its source',
    );
  const sinkInvocationKey = invocationKey({
    workflowVersionId: state.current.workflowVersionId,
    nodeId: route.sinkNodeId,
    branchPath: (source.branchPath ?? []).map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    iterationPath: source.iterationPath ?? [],
  });
  state.invocations.set(source.invocationKey, {
    ...source,
    failureHandling: { sinkInvocationKey, disposition: 'pending' },
  });
  const entryInvocationKey = invocationKey({
    workflowVersionId: state.current.workflowVersionId,
    nodeId: route.entryNodeId,
    branchPath: (source.branchPath ?? []).map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    iterationPath: source.iterationPath ?? [],
  });
  state.failureValues.push({ value: failure, entryInvocationKey });
  state.eventDrafts.push(
    transitionEvent('node.failure_routed', occurredAt, {
      invocation: source,
      reasonCode: failure.safeErrorCode,
    }),
  );
}

export function settleFailureHandlers(
  state: MutableWorkflowTransition,
  occurredAt: string,
): void {
  for (const source of state.invocations.values()) {
    const handling = source.failureHandling;
    if (
      handling?.disposition !== 'pending' ||
      state.cancelRequested ||
      state.deadlineExpired
    )
      continue;
    if (
      state.invocations.get(handling.sinkInvocationKey)?.status !== 'succeeded'
    )
      continue;
    const route = state.graph?.failureRoutes?.find(
      ({ sourceNodeId }) => sourceNodeId === source.nodeId,
    );
    if (
      route === undefined ||
      !isCompletedFailureHandler(
        source,
        route.handlerNodeIds,
        state.current.workflowVersionId,
        state.invocations,
      )
    )
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        'selected handler sink completed without its chain',
      );
    state.invocations.set(source.invocationKey, {
      ...source,
      failureHandling: { ...handling, disposition: 'handled' },
    });
    state.eventDrafts.push(
      transitionEvent('node.failure_handled', occurredAt, {
        invocation: source,
      }),
    );
  }
}
