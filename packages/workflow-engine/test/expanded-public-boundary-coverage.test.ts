import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createRegistryRelease,
  parseWorkflowExecutableV2,
  type RegistryRelease,
} from './executable-workflow.fixtures.js';
import {
  advanceWorkflow,
  decideCancellation,
  deriveReadyNodes,
  parseSchedulerGraph,
  planDurableWait,
} from '../src/testing.js';
import { branchPathHasPrefix } from '../src/scope.js';
import {
  boundedPolicy,
  graph,
  jsonataPolicy,
  nodeRelease,
} from './executable-workflow.fixtures.js';
import {
  chainGraph,
  checkpoint,
  occurredAt,
} from './support/advance-workflow.fixture.js';

function recreateRelease(
  release: RegistryRelease,
  changes: Partial<
    Pick<RegistryRelease, 'definitions' | 'executors' | 'policies'>
  >,
): RegistryRelease {
  return createRegistryRelease({
    epoch: release.epoch,
    definitions: changes.definitions ?? release.definitions,
    executors: changes.executors ?? release.executors,
    policies: changes.policies ?? release.policies,
  });
}

function baselineRelease(): RegistryRelease {
  return composeExecutableCompatibilityRelease(nodeRelease());
}

describe('expanded public workflow-engine boundaries', () => {
  it('rejects exact-shaped executable envelope identity drift', () => {
    const release = baselineRelease();
    const compiled = buildWorkflowExecutableV2({ graph: graph(), release });

    for (const mutate of [
      (envelope: Record<string, unknown>) => {
        envelope.schemaVersion = 3;
      },
      (envelope: Record<string, unknown>) => {
        envelope.compatibilityReleaseEpoch = release.epoch + 1;
      },
      (envelope: Record<string, unknown>) => {
        envelope.configMigrations = [{}];
      },
      (envelope: Record<string, unknown>) => {
        envelope.compatibilitySelectionFingerprint = 'mismatched-selection';
      },
    ]) {
      const envelope = structuredClone(compiled.envelope) as unknown as Record<
        string,
        unknown
      >;
      mutate(envelope);
      expect(() =>
        parseWorkflowExecutableV2({
          envelope,
          admissionRelease: release,
        }),
      ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    }
  });

  it('publishes deprecated definitions but rejects incompatible config and ABI pins', () => {
    const release = baselineRelease();
    const deprecated = recreateRelease(release, {
      definitions: release.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? { ...definition, lifecycle: 'deprecated' as const }
          : definition,
      ),
    });
    expect(
      buildWorkflowExecutableV2({ graph: graph(), release: deprecated })
        .envelope.graph.nodes,
    ).toHaveLength(3);

    const incompatibleGraph = structuredClone(graph());
    const setNode = incompatibleGraph.nodes.find(({ id }) => id === 'set');
    if (setNode === undefined) throw new Error('set fixture is missing');
    Object.assign(setNode, { configVersion: 2 });
    expect(() =>
      buildWorkflowExecutableV2({ graph: incompatibleGraph, release }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const missingAbi = recreateRelease(release, {
      definitions: release.definitions.map((definition) => {
        if (
          definition.definition.key !== 'core.manual' ||
          definition.schemaVersion !== 1
        )
          return definition;
        const { executorAbi: omitted, ...withoutAbi } = definition;
        void omitted;
        return withoutAbi;
      }),
    });
    expect(() =>
      buildWorkflowExecutableV2({ graph: graph(), release: missingAbi }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('canonicalizes reversed policy references and rejects invalid global policy sets', () => {
    const release = baselineRelease();
    const reversed = recreateRelease(release, {
      definitions: release.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? {
              ...definition,
              policyReferences: [jsonataPolicy, boundedPolicy],
            }
          : definition,
      ),
      executors: release.executors.map((executor) =>
        executor.executor.key === 'core.set'
          ? {
              ...executor,
              policyReferences: [jsonataPolicy, boundedPolicy],
            }
          : executor,
      ),
    });
    expect(
      buildWorkflowExecutableV2({
        graph: graph(),
        release: reversed,
      }).envelope.graph.nodes.find(({ id }) => id === 'set')?.policyReferences,
    ).toEqual([jsonataPolicy, boundedPolicy]);

    const policyV1 = { key: 'test.versioned', version: 1 } as const;
    const policyV2 = { key: 'test.versioned', version: 2 } as const;
    const reversedVersions = recreateRelease(release, {
      definitions: release.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? { ...definition, policyReferences: [policyV2, policyV1] }
          : definition,
      ),
      executors: release.executors.map((executor) =>
        executor.executor.key === 'core.set'
          ? { ...executor, policyReferences: [policyV2, policyV1] }
          : executor,
      ),
      policies: [...release.policies, policyV1, policyV2],
    });
    expect(
      buildWorkflowExecutableV2({
        graph: graph(),
        release: reversedVersions,
      }).envelope.graph.nodes.find(({ id }) => id === 'set')?.policyReferences,
    ).toEqual([policyV1, policyV2]);

    const releaseWithAlternative = composeExecutableCompatibilityRelease(
      nodeRelease({ extraPolicyVersion: 1 }),
    );
    const compiled = buildWorkflowExecutableV2({
      graph: graph(),
      release: releaseWithAlternative,
    });
    const nonBaseline = structuredClone(compiled.envelope);
    Object.assign(nonBaseline.runtimePolicies, {
      scheduler: { key: 'test.rollout', version: 1 },
    });
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: nonBaseline,
        admissionRelease: releaseWithAlternative,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const missingRuntimePolicy = recreateRelease(release, {
      policies: release.policies.filter(
        ({ key }) => key !== 'engine.cancellation',
      ),
    });
    expect(() =>
      buildWorkflowExecutableV2({
        graph: graph(),
        release: missingRuntimePolicy,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('covers durable-wait and cancellation terminal decisions', () => {
    expect(() =>
      planDurableWait({
        invocationKey: 'wait',
        resumeAt: 'not-a-timestamp',
        now: occurredAt,
      }),
    ).toThrow(TypeError);
    expect(
      planDurableWait({
        invocationKey: 'wait',
        resumeAt: occurredAt,
        now: occurredAt,
      }),
    ).toEqual({
      invocationKey: 'wait',
      transition: 'ready',
      resumeAt: null,
      releasesWorkerSlot: true,
    });
    expect(decideCancellation([])).toEqual({ kind: 'canceled' });
    expect(
      decideCancellation([
        {
          invocationKey: 'waiting',
          nodeId: 'wait',
          status: 'waiting',
          attemptNumber: 1,
        },
      ]),
    ).toEqual({
      kind: 'await_reconciliation',
      invocationKeys: ['waiting'],
    });
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
    const throwable: unknown = 'hostile input trap';
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw throwable;
        },
      },
    );

    expect(() =>
      buildWorkflowExecutableV2({ graph: graph(), release: hostile }),
    ).toThrow('executable processing failed');
    expect(() => parseSchedulerGraph(hostile)).toThrow('graph parsing failed');
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
    const decisions = (config: unknown) =>
      deriveReadyNodes({
        graph: {
          deriveReadiness: true,
          nodes: [
            {
              id: 'merge',
              definition: { key: 'core.merge', version: 1 },
              config,
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
