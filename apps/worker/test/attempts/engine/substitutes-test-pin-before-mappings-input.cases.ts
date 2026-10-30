import type { NodeAttemptLease } from '@pertexo/database/testing';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import {
  composeExecutableCatalog,
  invocationKey,
} from '@pertexo/workflow-engine';
import { expect, it, vi } from 'vitest';
import { createNodeAttemptExecutionEngine } from '../../../src/attempts/execution/engine.js';
import {
  RUN_ID,
  VERSION_ID,
  graph,
} from '../../support/attempts/execution-engine.js';
import {
  ATTEMPT_ID,
  OUTBOX_ID,
  branchGraph,
  compiledProjection,
  fixture,
} from './fixture.js';

export function registerSubstitutesTestPinBeforeMappingsInput(): void {
  it('substitutes a test pin before mappings, input capture or executor dispatch', async () => {
    const { catalog, projection, lease } = fixture('terminate');
    const execute = vi.fn();
    const onInputResolved = vi.fn().mockResolvedValue(undefined);
    const prepared = createNodeAttemptExecutionEngine({ catalog }).prepare({
      lease,
      projection: {
        ...projection,
        test: { pinnedNodeIds: ['terminate'] },
        testSample: { sampleId: OUTBOX_ID, output: { sample: 'frozen' } },
      },
    });
    expect(prepared.upstreamNodeOutputs).toEqual([]);
    await expect(
      prepared.execute({
        runInput: { different: true },
        completedNodeOutputs: [],
        control: { kind: 'none' },
        registry: { execute },
        onInputResolved,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'terminal_success',
      output: { sample: 'frozen' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(onInputResolved).not.toHaveBeenCalled();
  });

  it('keeps normal Wait suspension but completes it immediately in a draft test', async () => {
    const { catalog, lease } = fixture('manual');
    const source = graph();
    const projection = compiledProjection(
      {
        ...source,
        nodes: source.nodes.map((node) =>
          node.id === 'manual'
            ? {
                ...node,
                definition: { key: 'core.wait', version: 1 },
                config: { durationSeconds: 3600 },
              }
            : node,
        ),
      },
      catalog,
    );
    const engine = createNodeAttemptExecutionEngine({ catalog });
    expect(
      engine.prepare({ lease, projection }).suspensionDurationSeconds,
    ).toBe(3600);
    const prepared = engine.prepare({
      lease,
      projection: { ...projection, test: { pinnedNodeIds: [] } },
    });
    expect(prepared.suspensionDurationSeconds).toBeUndefined();
    await expect(
      prepared.execute({
        runInput: {},
        completedNodeOutputs: [],
        control: { kind: 'none' },
        registry: createCoreNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
  });

  it('verifies the pinned executable and executes Manual using only run input', async () => {
    const { catalog, projection, lease } = fixture('manual');
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
    });
    const prepared = engine.prepare({ projection, lease });

    expect(prepared.upstreamNodeOutputs).toEqual([]);
    await expect(
      prepared.execute({
        runInput: { hello: 'world' },
        completedNodeOutputs: [],
        control: { kind: 'none' },
        registry: createCoreNodeRegistry(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      nodeId: 'manual',
      kind: 'succeeded',
      output: { hello: 'world' },
    });
  });

  it('hands the resolved input to be recorded, except for a step that uses a connection', async () => {
    const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
    const run = async (connectionRefs: Readonly<Record<string, string>>) => {
      const base = graph();
      const [manual, ...rest] = base.nodes;
      if (manual === undefined) throw new Error('fixture graph is missing');
      const projection = compiledProjection(
        { ...base, nodes: [{ ...manual, connectionRefs }, ...rest] },
        catalog,
      );
      const engine = createNodeAttemptExecutionEngine({
        catalog: catalog,
      });
      const onInputResolved = vi.fn(() => Promise.resolve());
      await engine
        .prepare({ projection, lease: fixture('manual').lease })
        .execute({
          runInput: { hello: 'world' },
          completedNodeOutputs: [],
          control: { kind: 'none' },
          registry: createCoreNodeRegistry(),
          signal: new AbortController().signal,
          onInputResolved,
        });
      return onInputResolved;
    };

    expect(await run({})).toHaveBeenCalledWith({ hello: 'world' });
    // What a connected step receives is what it sends to a provider.
    expect(
      await run({ provider: '88888888-8888-4888-8888-888888888888' }),
    ).not.toHaveBeenCalled();
  });

  it('derives the exact direct-upstream set', () => {
    const { catalog, projection, lease } = fixture('terminate');
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
    });

    expect(engine.prepare({ projection, lease }).upstreamNodeOutputs).toEqual([
      { nodeId: 'manual', invocationKey: `${VERSION_ID}|manual|b:|i:` },
    ]);
  });

  it('rejects a node that is not in the workflow', () => {
    const { catalog, projection, lease } = fixture('manual');
    const engine = createNodeAttemptExecutionEngine({
      catalog: catalog,
    });

    expect(() =>
      engine.prepare({
        projection,
        lease: {
          ...lease,
          nodeId: 'missing',
          invocationKey: invocationKey({
            workflowVersionId: VERSION_ID,
            nodeId: 'missing',
          }),
        },
      }),
    ).toThrow('not in workflow');
  });

  it.each([
    ['condition', 'true'],
    ['switch', 'case-01'],
  ] as const)(
    'reads the %s that introduces a selected path from the parent scope',
    (kind, selectedPort) => {
      const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
      const projection = compiledProjection(branchGraph(kind), catalog);
      const engine = createNodeAttemptExecutionEngine({
        catalog: catalog,
      });
      const selectedLease: NodeAttemptLease = {
        ...fixture('manual').lease,
        nodeId: 'selected',
        branchPath: [{ nodeId: kind, outputPort: selectedPort }],
        invocationKey: invocationKey({
          workflowVersionId: VERSION_ID,
          nodeId: 'selected',
          branchPath: [`${kind}:${selectedPort}`],
        }),
      };
      expect(
        engine.prepare({ projection, lease: selectedLease })
          .upstreamNodeOutputs,
      ).toEqual([
        {
          nodeId: kind,
          invocationKey: invocationKey({
            workflowVersionId: VERSION_ID,
            nodeId: kind,
          }),
        },
      ]);
    },
  );
}
