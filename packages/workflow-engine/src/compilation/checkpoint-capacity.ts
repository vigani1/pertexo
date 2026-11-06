import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  utf8ByteLength,
  type ControlNodeConfig,
} from '@pertexo/workflow-model';
import { configuredScopedOutputPorts } from '../control-output-ports.js';
import type {
  BranchScopePart,
  IterationScopePart,
  InvocationState,
  WorkflowCheckpoint,
} from '../workflow-execution.js';
import type { WorkflowExecutableNode } from './workflow-executable.js';

export type Scope = Readonly<{
  branchPath: readonly BranchScopePart[];
  iterationPath: readonly IterationScopePart[];
}>;
export type CapacityCheckpoint = {
  -readonly [
    K in keyof WorkflowCheckpoint
  ]: WorkflowCheckpoint[K] extends readonly (infer T)[]
    ? T[]
    : WorkflowCheckpoint[K];
};
const output = {
  kind: 'artifact',
  artifactId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
} as const;
const jsonBytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));

/** A size upper bound only; these co-reserved fields are never persisted. */
export function reserveCheckpointNode(
  checkpoint: CapacityCheckpoint,
  node: WorkflowExecutableNode,
  {
    key,
    scope,
    copies,
    control,
    handlesFailure,
    maySuspend,
    branches,
  }: Readonly<{
    key: string;
    scope: Scope;
    copies: number;
    control: ControlNodeConfig | undefined;
    handlesFailure: boolean;
    maySuspend: boolean;
    branches: readonly string[];
  }>,
): void {
  for (let copy = 0; copy < copies; copy++) {
    const identity = {
      invocationKey: key,
      nodeId: node.id,
      attemptNumber: Number.MAX_SAFE_INTEGER,
      ...scope,
    };
    const ready: InvocationState = {
      ...identity,
      ...(maySuspend ? { output } : {}),
      status: 'ready',
      waitKind: 'retry_backoff',
    };
    const waiting: InvocationState = {
      ...identity,
      ...(maySuspend || node.structured !== undefined ? { output } : {}),
      status: 'waiting',
      waitKind: 'retry_backoff',
      resumeAt: '9999-12-31T23:59:59.999Z',
    };
    const variants: { invocation: InvocationState; ready: string[] }[] = [
      { invocation: ready, ready: [key] },
      { invocation: waiting, ready: [] },
      {
        invocation: { ...identity, status: 'outcome_unknown', output },
        ready: [],
      },
    ];
    if (handlesFailure)
      variants.push({
        invocation: {
          ...identity,
          status: 'failed',
          output,
          failureHandling: {
            sinkInvocationKey: 'x'.repeat(
              WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength,
            ),
            disposition: 'pending',
          },
        },
        ready: [],
      });
    const largest = variants.reduce((left, right) =>
      jsonBytes(right) > jsonBytes(left) ? right : left,
    );
    checkpoint.invocations.push(largest.invocation);
    checkpoint.readySet.push(...largest.ready);
    checkpoint.admittedInvocationKeys.push(key);
    const ports = configuredScopedOutputPorts({
      ...node,
      ...(control === undefined ? {} : { control }),
    });
    if (ports !== undefined && control?.kind !== 'parallel') {
      const longest = [...ports].sort((a, b) => jsonBytes(b) - jsonBytes(a))[0];
      if (longest !== undefined)
        checkpoint.branchSelections.push({
          invocationKey: key,
          nodeId: node.id,
          selectedOutputPort: longest,
        });
    }
    if (control?.kind === 'merge')
      reserveJoin(checkpoint, {
        nodeId: node.id,
        key,
        scope,
        control,
        branches,
      });
    if (node.structured !== undefined) {
      const { body, maxIterations, maxConcurrency } = node.structured;
      const active = Math.min(maxIterations, maxConcurrency);
      const incoming = new Set(body.edges.map((edge) => edge.target.nodeId));
      checkpoint.loops.push({
        controlInvocationKey: key,
        loopId: node.id,
        ...scope,
        bodyRootNodeIds: body.nodes
          .filter((child) => !incoming.has(child.id))
          .map((child) => child.id),
        bodySinkNodeId:
          [...body.nodes].sort((a, b) => jsonBytes(b.id) - jsonBytes(a.id))[0]
            ?.id ?? '',
        collection: output,
        collectionChecksum: `sha256:${'f'.repeat(64)}`,
        collectionSize: maxIterations,
        maxConcurrency,
        maxIterations,
        nextOrdinal: maxIterations,
        completedPrefix: 0,
        activeOrdinals: Array.from({ length: active }, (_, n) => n),
        terminalOrdinals: Array.from(
          { length: maxIterations - active },
          (_, n) => n + active,
        ),
        terminalStatus: 'outcome_unknown',
      });
    }
  }
}

function reserveJoin(
  checkpoint: CapacityCheckpoint,
  {
    nodeId,
    key,
    scope,
    control,
    branches,
  }: Readonly<{
    nodeId: string;
    key: string;
    scope: Scope;
    control: Extract<ControlNodeConfig, { kind: 'merge' }>;
    branches: readonly string[];
  }>,
): void {
  const policy = control.config.policy;
  let selectedCount = branches.length;
  if (policy.kind === 'any') selectedCount = 1;
  if (policy.kind === 'count') selectedCount = policy.count;
  checkpoint.joins.push({
    joinInvocationKey: key,
    joinId: nodeId,
    ...scope,
    policy,
    ledger: branches.map((branchId) => ({
      branchId,
      disposition: 'arrived',
      output,
    })),
    selectedBranchIds: branches.slice(0, selectedCount),
    unsatisfiedReasonCode: 'insufficient_arrivals',
  });
}
