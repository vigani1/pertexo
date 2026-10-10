import { describe, expect, it } from 'vitest';
import { createNodeCatalog, type NodeCatalog } from '@pertexo/node-sdk';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseWorkflowExecutable,
} from '../src/index.js';
import {
  advanceWorkflow,
  deriveReadyNodes,
  parseSchedulerGraph,
} from './support/engine.js';
import { branchPathHasPrefix } from '../src/scope.js';
import {
  boundedPolicy,
  graph,
  jsonataPolicy,
  nodeCatalog,
} from './support/executable-workflow.js';
import {
  chainGraph,
  checkpoint,
  occurredAt,
} from './support/advance-workflow.js';

function recreateCatalog(
  catalog: NodeCatalog,
  changes: Partial<Pick<NodeCatalog, 'definitions' | 'executors' | 'policies'>>,
): NodeCatalog {
  return createNodeCatalog({
    definitions: changes.definitions ?? catalog.definitions,
    executors: changes.executors ?? catalog.executors,
    policies: changes.policies ?? catalog.policies,
  });
}

function baselineCatalog(): NodeCatalog {
  return composeExecutableCatalog(nodeCatalog());
}

describe('expanded public workflow-engine boundaries', () => {
  it('rejects an unknown schema version or extra envelope fields', () => {
    const catalog = baselineCatalog();
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });

    for (const mutate of [
      (envelope: Record<string, unknown>) => {
        envelope.schemaVersion = 3;
      },
      (envelope: Record<string, unknown>) => {
        envelope.unexpected = 1;
      },
    ]) {
      const envelope = structuredClone(compiled.envelope) as unknown as Record<
        string,
        unknown
      >;
      mutate(envelope);
      expect(() =>
        parseWorkflowExecutable({
          envelope,
          catalog: catalog,
        }),
      ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    }
  });

  it('rejects incompatible config pins', () => {
    const catalog = baselineCatalog();
    const incompatibleGraph = structuredClone(graph());
    const setNode = incompatibleGraph.nodes.find(({ id }) => id === 'set');
    if (setNode === undefined) throw new Error('set fixture is missing');
    Object.assign(setNode, { configVersion: 2 });
    expect(() =>
      buildWorkflowExecutable({ graph: incompatibleGraph, catalog }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('canonicalizes reversed policy references and rejects invalid global policy sets', () => {
    const catalog = baselineCatalog();
    const reversed = recreateCatalog(catalog, {
      definitions: catalog.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? {
              ...definition,
              policyReferences: [jsonataPolicy, boundedPolicy],
            }
          : definition,
      ),
      executors: catalog.executors.map((executor) =>
        executor.executor.key === 'core.set'
          ? {
              ...executor,
              policyReferences: [jsonataPolicy, boundedPolicy],
            }
          : executor,
      ),
    });
    expect(
      buildWorkflowExecutable({
        graph: graph(),
        catalog: reversed,
      }).envelope.graph.nodes.find(({ id }) => id === 'set')?.policyReferences,
    ).toEqual([jsonataPolicy, boundedPolicy]);

    const policyV1 = { key: 'test.versioned', version: 1 } as const;
    const policyV2 = { key: 'test.versioned', version: 2 } as const;
    const reversedVersions = recreateCatalog(catalog, {
      definitions: catalog.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? { ...definition, policyReferences: [policyV2, policyV1] }
          : definition,
      ),
      executors: catalog.executors.map((executor) =>
        executor.executor.key === 'core.set'
          ? { ...executor, policyReferences: [policyV2, policyV1] }
          : executor,
      ),
      policies: [...catalog.policies, policyV1, policyV2],
    });
    expect(
      buildWorkflowExecutable({
        graph: graph(),
        catalog: reversedVersions,
      }).envelope.graph.nodes.find(({ id }) => id === 'set')?.policyReferences,
    ).toEqual([policyV1, policyV2]);

    const catalogWithAlternative = composeExecutableCatalog(
      nodeCatalog({ extraPolicyVersion: 1 }),
    );
    const compiled = buildWorkflowExecutable({
      graph: graph(),
      catalog: catalogWithAlternative,
    });
    const nonBaseline = structuredClone(compiled.envelope);
    Object.assign(nonBaseline.runtimePolicies, {
      scheduler: { key: 'test.rollout', version: 1 },
    });
    expect(() =>
      parseWorkflowExecutable({
        envelope: nonBaseline,
        catalog: catalogWithAlternative,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const missingRuntimePolicy = recreateCatalog(catalog, {
      policies: catalog.policies.filter(
        ({ key }) => key !== 'engine.cancellation',
      ),
    });
    expect(() =>
      buildWorkflowExecutable({
        graph: graph(),
        catalog: missingRuntimePolicy,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('treats an absent branch prefix as the root scope', () => {
    expect(
      branchPathHasPrefix(
        [{ nodeId: 'condition', outputPort: 'true' }],
        undefined,
      ),
    ).toBe(true);
  });

  it('preserves disabled graph nodes and normalizes invalid graph failures', () => {
    const disabledGraph = structuredClone(chainGraph);
    const disabledNode = disabledGraph.nodes[0];
    if (disabledNode === undefined) throw new Error('node fixture is missing');
    Object.assign(disabledNode, { disabled: true });
    expect(parseSchedulerGraph(disabledGraph).nodes[0]).toMatchObject({
      id: 'a',
      disabled: true,
    });

    const invalidGraph = structuredClone(chainGraph);
    Object.assign(invalidGraph.edges[0].target, { nodeId: 'missing' });
    expect(() => parseSchedulerGraph(invalidGraph)).toThrow(
      expect.objectContaining({ code: 'graph_invalid' }),
    );
  });

  it('normalizes non-Error failures raised while reading hostile public input', () => {
    const throwingMessage = new Error('private hostile message');
    Object.defineProperty(throwingMessage, 'message', {
      get() {
        throw new Error('secondary message failure');
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const [name, throwable] of [
      ['primitive rejection', 'hostile input trap'],
      ['throwing message getter', throwingMessage],
      ['revoked proxy rejection', revoked.proxy],
    ] as const) {
      const hostile = new Proxy(
        {},
        {
          ownKeys: () => {
            // The boundary must remain total for hostile thrown values.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw throwable;
          },
        },
      );

      expect(
        () => buildWorkflowExecutable({ graph: graph(), catalog: hostile }),
        name,
      ).toThrow('executable processing failed');
      expect(() => parseSchedulerGraph(hostile), name).toThrow(
        expect.objectContaining({
          code: 'graph_invalid',
          message: 'graph input could not be inspected safely at $',
        }),
      );
    }
  });

  it('uses the direct graph route and rejects ambiguous testing inputs', () => {
    expect(
      advanceWorkflow({
        checkpoint: checkpoint(),
        graph: chainGraph,
        occurredAt,
        maximumAdmissions: 1,
      }).attempts.map(({ nodeId }) => nodeId),
    ).toEqual(['a']);

    expect(() =>
      advanceWorkflow({
        checkpoint: checkpoint(),
        graph: chainGraph,
        schedulerState: parseSchedulerGraph(chainGraph),
        occurredAt,
        maximumAdmissions: 1,
      }),
    ).toThrow('provide graph or schedulerState, not both');
  });

  it('leaves malformed Merge pair metadata unpaired at the public testing seam', () => {
    const decisions = (config: Readonly<Record<string, unknown>> | undefined) =>
      deriveReadyNodes({
        graph: {
          deriveReadiness: true,
          nodes: [
            {
              id: 'merge',
              definition: { key: 'core.merge', version: 1 },
              ...(config === undefined ? {} : { config }),
              sideEffectClass: 'safe',
            },
          ],
          edges: [],
        },
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocations: [],
      });

    expect(decisions(undefined).map(({ nodeId }) => nodeId)).toEqual(['merge']);
    expect(
      decisions({ parallelNodeId: 42 }).map(({ nodeId }) => nodeId),
    ).toEqual(['merge']);
  });
});
