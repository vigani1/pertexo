import {
  executableFailureRoutes,
  type CompiledWorkflowExecutable,
} from '../compilation/foundation.js';
import { operationError } from '../operation-values.js';
import type { InvocationState, WorkflowCheckpoint } from '../types.js';
import { invocationKey } from '../transition/scheduling/loops.js';
import { isSelectedFailureScope, isCompletedFailureHandler } from './scope.js';

function expectedInvocationKey(
  source: InvocationState,
  workflowVersionId: string,
): string {
  return invocationKey({
    workflowVersionId,
    nodeId: source.nodeId,
    branchPath: (source.branchPath ?? []).map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    iterationPath: source.iterationPath ?? [],
  });
}

export function assertFailureCheckpoint(
  checkpoint: WorkflowCheckpoint,
  executable: CompiledWorkflowExecutable,
): void {
  const compiledRoutes = executableFailureRoutes(executable);
  if (
    compiledRoutes.length === 0 &&
    !checkpoint.invocations.some(
      ({ failureHandling }) => failureHandling !== undefined,
    )
  )
    return;
  const routes = new Map(
    compiledRoutes.map((route) => [route.sourceNodeId, route]),
  );
  const handlerOwners = new Map(
    [...routes.values()].flatMap((route) =>
      route.handlerNodeIds.map(
        (nodeId) => [nodeId, route.sourceNodeId] as const,
      ),
    ),
  );
  const byKey = new Map(
    checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const invocation of checkpoint.invocations) {
    if (invocation.failureHandling !== undefined) {
      assertSelectedFailure(invocation, invocation.failureHandling, {
        executable,
        checkpoint,
        byKey,
        routes,
      });
    }
    const ownerNodeId = handlerOwners.get(invocation.nodeId);
    if (ownerNodeId !== undefined && invocation.status === 'skipped') {
      const ownerKey = expectedInvocationKey(
        { ...invocation, nodeId: ownerNodeId },
        checkpoint.workflowVersionId,
      );
      if (byKey.get(ownerKey)?.failureHandling !== undefined)
        operationError(
          'workflow_identity_invalid',
          'selected handler cannot contain skipped steps',
        );
    }
    if (ownerNodeId !== undefined && invocation.status !== 'skipped') {
      const ownerKey = expectedInvocationKey(
        { ...invocation, nodeId: ownerNodeId },
        checkpoint.workflowVersionId,
      );
      if (byKey.get(ownerKey)?.failureHandling === undefined)
        operationError(
          'workflow_identity_invalid',
          'active handler has no selected source failure',
        );
    }
  }
}

function assertSelectedFailure(
  invocation: InvocationState,
  handling: NonNullable<InvocationState['failureHandling']>,
  {
    executable,
    checkpoint,
    byKey,
    routes,
  }: Readonly<{
    executable: CompiledWorkflowExecutable;
    checkpoint: WorkflowCheckpoint;
    byKey: ReadonlyMap<string, InvocationState>;
    routes: ReadonlyMap<
      string,
      ReturnType<typeof executableFailureRoutes>[number]
    >;
  }>,
): void {
  if (
    executable.envelope.graph.nodes.find(({ id }) => id === invocation.nodeId)
      ?.disabled
  )
    operationError(
      'workflow_identity_invalid',
      'disabled source cannot select a handler',
    );
  if (
    !isSelectedFailureScope(
      invocation,
      checkpoint.workflowVersionId,
      byKey,
      checkpoint.branchSelections,
    )
  )
    operationError(
      'workflow_identity_invalid',
      'selected failure is not in its executed choice scope',
    );
  const route = routes.get(invocation.nodeId);
  const expectedSink =
    route === undefined
      ? undefined
      : expectedInvocationKey(
          { ...invocation, nodeId: route.sinkNodeId },
          checkpoint.workflowVersionId,
        );
  const sink = byKey.get(handling.sinkInvocationKey);
  const sinkMismatch =
    expectedSink !== handling.sinkInvocationKey ||
    (handling.disposition === 'handled' && sink?.status !== 'succeeded');
  if (sinkMismatch)
    operationError(
      'workflow_identity_invalid',
      'failure handling disagrees with its pinned route or sink',
    );
  const incompleteHandler =
    (sink?.status === 'succeeded' || handling.disposition === 'handled') &&
    (route === undefined ||
      !isCompletedFailureHandler(
        invocation,
        route.handlerNodeIds,
        checkpoint.workflowVersionId,
        byKey,
      ));
  if (incompleteHandler)
    operationError(
      'workflow_identity_invalid',
      'handled failure requires the complete selected handler chain',
    );
}
