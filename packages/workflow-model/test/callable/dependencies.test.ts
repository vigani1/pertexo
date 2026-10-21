import { describe, expect, it, vi } from 'vitest';
import {
  validateCallDependencyClosure,
  summarizeWorkflowCalls,
  type CallableVersionSummary,
} from '../../src/flow/callable/dependencies.js';

const version = (
  workflowId: string,
  workflowVersionId: string,
  expandedInvocations = 1,
  calls: CallableVersionSummary['calls'] = [],
): CallableVersionSummary => ({
  workspaceId: 'workspace',
  workflowId,
  workflowVersionId,
  executableChecksum: `checksum-${workflowVersionId}`,
  expandedInvocations,
  calls,
});
const call = (pin: CallableVersionSummary, multiplicity = 1) => ({
  nodeId: 'call',
  pin,
  multiplicity,
});
const reader = (...versions: CallableVersionSummary[]) =>
  vi.fn((pin: CallableVersionSummary['calls'][number]['pin']) => {
    const target = versions.find(
      ({ workflowVersionId }) => workflowVersionId === pin.workflowVersionId,
    );
    if (target === undefined) throw new Error('version is absent');
    return Promise.resolve(target);
  });

describe('Call publication closure', () => {
  it('counts repeated sites and loop products while resolving each version once', async () => {
    const shared = version('shared', 'shared-v1', 3);
    const left = version('left', 'left-v1', 2, [call(shared, 2)]);
    const right = version('right', 'right-v1', 1, [call(shared)]);
    const root = version('root', 'root-v1', 3, [
      call(left),
      call(right),
      call(left, 2),
    ]);
    const resolve = reader(left, right, shared);
    expect(await validateCallDependencyClosure(root, resolve, 200)).toBe(31);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('rejects a workflow ancestor even when the version differs', async () => {
    const anotherRoot = version('root', 'root-v2');
    const child = version('child', 'child-v1', 1, [call(anotherRoot)]);
    const root = version('root', 'root-v1', 1, [call(child)]);
    await expect(
      validateCallDependencyClosure(root, reader(child, anotherRoot), 200),
    ).rejects.toMatchObject({ code: 'cycle' });
  });

  it('checks cached descendants against the current workflow-identity path', async () => {
    const oldAncestor = version('ancestor', 'ancestor-v1');
    const shared = version('shared', 'shared-v1', 1, [call(oldAncestor)]);
    const newAncestor = version('ancestor', 'ancestor-v2', 1, [call(shared)]);
    const root = version('root', 'root-v1', 2, [
      call(shared),
      call(newAncestor),
    ]);
    await expect(
      validateCallDependencyClosure(
        root,
        reader(shared, oldAncestor, newAncestor),
        200,
      ),
    ).rejects.toMatchObject({ code: 'cycle' });
  });

  it('rejects another workspace or any rebound immutable identity', async () => {
    const child = version('child', 'child-v1');
    const root = version('root', 'root-v1', 1, [call(child)]);
    for (const changed of [
      { ...child, workspaceId: 'other-workspace' },
      { ...child, workflowId: 'other-workflow' },
      { ...child, workflowVersionId: 'other-version' },
      { ...child, executableChecksum: 'changed' },
    ])
      await expect(
        validateCallDependencyClosure(
          root,
          () => Promise.resolve(changed),
          200,
        ),
      ).rejects.toMatchObject({
        code: changed.workspaceId !== child.workspaceId ? 'workspace' : 'pin',
      });
  });

  it('accepts the existing limit exactly and stops before resolving an overflowing sibling', async () => {
    const child = version('child', 'child-v1', 2);
    const root = version('root', 'root-v1', 2, [call(child, 99)]);
    expect(await validateCallDependencyClosure(root, reader(child), 200)).toBe(
      200,
    );
    const sibling = version('sibling', 'sibling-v1');
    const resolve = reader(child, sibling);
    await expect(
      validateCallDependencyClosure(
        { ...root, calls: [call(child, 100), call(sibling)] },
        resolve,
        200,
      ),
    ).rejects.toMatchObject({ code: 'expansion' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting pins even after a sibling resolved the same version', async () => {
    const child = version('child', 'child-v1');
    const root = version('root', 'root-v1', 2, [
      call(child),
      call({ ...child, executableChecksum: 'changed' }),
    ]);
    await expect(
      validateCallDependencyClosure(root, reader(child), 200),
    ).rejects.toMatchObject({ code: 'pin' });
  });
});

it('preserves nested loop products and scoped site identities in publication summaries', () => {
  const pin = {
    workflowId: '11111111-1111-4111-8111-111111111111',
    workflowVersionId: '22222222-2222-4222-8222-222222222222',
    executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
  };
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    position: { x: 0, y: 0 },
  });
  const body = {
    settings: {},
    nodes: [{ ...node('deep', 'core.call'), config: { target: pin } }],
    edges: [],
    inputPorts: ['item', 'ordinal'],
    outputPorts: ['result'],
  };
  const graph = {
    settings: {},
    edges: [],
    nodes: [
      {
        ...node('loop', 'core.foreach'),
        structured: {
          kind: 'for_each' as const,
          maxIterations: 10,
          maxConcurrency: 1,
          body: {
            ...body,
            nodes: [
              {
                ...node('nested', 'core.foreach'),
                structured: {
                  kind: 'for_each' as const,
                  maxIterations: 3,
                  maxConcurrency: 1,
                  body,
                },
              },
            ],
          },
        },
      },
    ],
  };
  expect(
    summarizeWorkflowCalls({ ...pin, workspaceId: 'workspace' }, graph, 41)
      .calls,
  ).toEqual([{ nodeId: 'deep', pin, multiplicity: 30 }]);
});
