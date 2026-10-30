import type {
  BranchScopePart,
  InvocationState,
  IterationScopePart,
} from '../../../src/index.js';
import { invocationKey } from '../../../src/index.js';
import type { SchedulerState } from '../../../src/transition/scheduling/policy.js';

export { runBypass } from './bypass.js';
export const workflowVersionId = '00000000-0000-4000-8000-000000000601';

export const occurredAt = '2026-09-06T00:00:00.000Z';

export function pairedSchedulerGraph(extraPredecessor = false): SchedulerState {
  return {
    deriveReadiness: true as const,
    nodes: [
      {
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        control: {
          kind: 'parallel',
          config: {
            branches: [
              { id: 'branch-01' as const },
              { id: 'branch-02' as const },
            ],
            maxConcurrency: 1,
          },
        },
        sideEffectClass: 'safe' as const,
      },
      { id: 'left', sideEffectClass: 'safe' as const },
      { id: 'right', sideEffectClass: 'safe' as const },
      ...(extraPredecessor
        ? [{ id: 'guard', sideEffectClass: 'safe' as const }]
        : []),
      {
        id: 'merge',
        definition: { key: 'core.merge', version: 1 },
        control: {
          kind: 'merge',
          config: {
            parallelNodeId: 'parallel',
            policy: { kind: 'all' as const },
          },
        },
        sideEffectClass: 'safe' as const,
      },
      { id: 'after', sideEffectClass: 'safe' as const },
    ],
    edges: [
      {
        source: { nodeId: 'parallel', port: 'branch-01' },
        target: { nodeId: 'left', port: 'in' },
      },
      {
        source: { nodeId: 'parallel', port: 'branch-02' },
        target: { nodeId: 'right', port: 'in' },
      },
      {
        source: { nodeId: 'left', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-01' },
      },
      {
        source: { nodeId: 'right', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-02' },
      },
      ...(extraPredecessor
        ? [
            {
              source: { nodeId: 'guard', port: 'out' },
              target: { nodeId: 'merge', port: 'in' },
            },
          ]
        : []),
      {
        source: { nodeId: 'merge', port: 'out' },
        target: { nodeId: 'after', port: 'in' },
      },
    ],
  };
}

export function scopedInvocation(
  workflowId: string,
  nodeId: string,
  status: InvocationState['status'],
  input: Readonly<{
    readonly branchPath?: readonly BranchScopePart[];
    readonly iterationPath?: readonly IterationScopePart[];
  }> = {},
): InvocationState {
  return {
    invocationKey: invocationKey({
      workflowVersionId: workflowId,
      nodeId,
      ...(input.branchPath === undefined
        ? {}
        : {
            branchPath: input.branchPath.map(
              ({ nodeId: branchNodeId, outputPort }) =>
                `${branchNodeId}:${outputPort}`,
            ),
          }),
      ...(input.iterationPath === undefined
        ? {}
        : { iterationPath: input.iterationPath }),
    }),
    nodeId,
    status,
    attemptNumber: status === 'succeeded' ? 1 : 0,
    ...(input.branchPath === undefined ? {} : { branchPath: input.branchPath }),
    ...(input.iterationPath === undefined
      ? {}
      : { iterationPath: input.iterationPath }),
    ...(status === 'succeeded'
      ? {
          output: {
            kind: 'inline' as const,
            attemptId: '00000000-0000-4000-8000-000000000601',
          },
        }
      : {}),
  };
}
