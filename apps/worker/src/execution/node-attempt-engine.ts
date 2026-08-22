import type {
  NodeAttemptInputs,
  NodeAttemptLease,
  PublishedWorkflowV2Projection,
} from '@pertexo/database';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import {
  executeNodeAttempt,
  verifyWorkflowExecutableV2,
  type ExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';

import type {
  NodeAttemptExecutionEngine,
  PreparedNodeAttempt,
} from './node-attempt-handler.js';

export type NodeAttemptExecutionEngineOptions = Readonly<{
  admissionRelease: unknown;
  currentRelease?: unknown;
  releaseSupport?: ExecutableCompatibilityReleaseSupport;
}>;

function verifyProjection(
  projection: PublishedWorkflowV2Projection,
  options: NodeAttemptExecutionEngineOptions,
) {
  const supportedCurrent = projection.currentCompatibilityRelease;
  const admissionDescription = options.releaseSupport?.descriptions.find(
    ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
  );
  if (
    options.releaseSupport !== undefined &&
    (supportedCurrent === undefined || admissionDescription === undefined)
  )
    throw new TypeError('Published workflow compatibility release is missing');
  const admissionRelease =
    options.releaseSupport === undefined
      ? options.admissionRelease
      : options.releaseSupport.resolve(
          admissionDescription?.epoch ?? 0,
          admissionDescription?.fingerprint ?? '',
        );
  const currentRelease =
    options.releaseSupport === undefined
      ? options.currentRelease
      : options.releaseSupport.resolve(
          supportedCurrent?.epoch ?? 0,
          supportedCurrent?.fingerprint ?? '',
        );
  const executable = verifyWorkflowExecutableV2({
    envelope: projection.executableJson,
    checksum: projection.checksum,
    admissionRelease,
    ...(currentRelease === undefined ? {} : { currentRelease }),
    execution: { alreadyAdmitted: true },
  });
  if (
    executable.envelope.compatibilityReleaseEpoch !==
    projection.compatibilityReleaseEpoch
  )
    throw new TypeError(
      'Published workflow compatibility release epoch does not match its executable envelope',
    );
  return executable;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function prepareNode(
  projection: PublishedWorkflowV2Projection,
  lease: NodeAttemptLease,
  options: NodeAttemptExecutionEngineOptions,
): PreparedNodeAttempt {
  if (projection.id !== lease.workflowVersionId)
    throw new TypeError(
      'Node attempt workflow version identity does not match',
    );
  const executable = verifyProjection(projection, options);
  const node = executable.envelope.graph.nodes.find(
    ({ id }) => id === lease.nodeId,
  );
  if (node === undefined)
    throw new TypeError('Node attempt is not in workflow');
  if (node.sideEffectClass !== lease.sideEffectClass)
    throw new TypeError(
      'Node attempt side-effect class does not match its pin',
    );
  const upstreamNodeIds = Object.freeze(
    [
      ...new Set(
        executable.envelope.graph.edges
          .filter(({ target }) => target.nodeId === node.id)
          .map(({ source }) => source.nodeId),
      ),
    ].sort(ordinal),
  );
  return Object.freeze({
    upstreamNodeIds,
    execute: async (
      input: Readonly<
        NodeAttemptInputs & {
          registry: NodeExecutionRegistry;
          runtime?: NodeExecutionRuntime;
          signal: AbortSignal;
        }
      >,
    ) => {
      if (input.abortRequested)
        throw new DOMException('The operation was aborted', 'AbortError');
      return executeNodeAttempt({
        runId: lease.runId,
        nodeRunId: lease.nodeRunId,
        attemptId: lease.attemptId,
        executable,
        workflowVersionId: lease.workflowVersionId,
        invocationKey: lease.invocationKey,
        nodeId: lease.nodeId,
        runInput: input.runInput,
        completedNodeOutputs: input.completedNodeOutputs,
        registry: input.registry,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        signal: input.signal,
      });
    },
  });
}

export function createNodeAttemptExecutionEngine(
  options: NodeAttemptExecutionEngineOptions,
): NodeAttemptExecutionEngine {
  return Object.freeze({
    prepare: (
      input: Readonly<{
        projection: PublishedWorkflowV2Projection;
        lease: NodeAttemptLease;
      }>,
    ) => prepareNode(input.projection, input.lease, options),
  });
}
