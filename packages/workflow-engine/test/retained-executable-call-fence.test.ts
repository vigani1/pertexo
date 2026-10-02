import { createRegistryRelease } from '@pertexo/node-sdk';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_RUNTIME_POLICIES_V1,
  buildWorkflowExecutableV2,
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
  parseWorkflowExecutableV2,
} from '../src/index.js';
import { selectionFingerprint } from '../src/compilation/executable-identity.js';
import type { WorkflowExecutableV2 } from '../src/executable-workflow.js';
import { graph, nodeRelease } from './executable-workflow.fixtures.js';

function callFixture() {
  const previous = nodeRelease();
  const base = previous.definitions.find(
    ({ definition }) => definition.key === 'core.set',
  );
  if (base === undefined) throw new Error('missing set fixture');
  const identity = { key: 'core.workflow_call', version: 1 };
  const manifest = { ...base, definition: identity, executor: identity };
  const release = composeExecutableCompatibilityReleaseV3(
    createRegistryRelease({
      epoch: previous.epoch,
      definitions: [...previous.definitions, manifest],
      executors: [
        ...previous.executors,
        {
          executor: identity,
          abiVersion: 1,
          definitions: [identity],
          lifecycle: 'active',
          policyReferences: manifest.policyReferences,
        },
      ],
      policies: previous.policies,
    }),
  );
  const source = graph();
  return {
    release,
    source: {
      ...source,
      nodes: source.nodes.map((node) =>
        node.definition.key === 'core.set'
          ? { ...node, definition: identity }
          : node,
      ),
    },
  };
}

describe('retained executable V2 workflow call fence', () => {
  it('refuses new call semantics even when the catalog knows the definition', () => {
    const fixture = callFixture();
    expect(() =>
      buildWorkflowExecutableV2({
        graph: fixture.source,
        release: fixture.release,
      }),
    ).toThrow('workflow calls require executable V3 and source graph V2');
  });

  it('refuses an otherwise compatible V2 envelope containing a call node', () => {
    const fixture = callFixture();
    const compiled = buildWorkflowExecutableV3({
      graph: { ...fixture.source, schemaVersion: 2 },
      release: fixture.release,
    });
    const envelope: WorkflowExecutableV2 = {
      schemaVersion: 2,
      sourceGraphSchemaVersion: 1,
      graph: compiled.envelope.graph,
      runtimePolicies: BASELINE_RUNTIME_POLICIES_V1,
      configMigrations: [],
      compatibilitySelectionFingerprint: selectionFingerprint(
        fixture.release,
        compiled.envelope.graph.nodes,
        BASELINE_RUNTIME_POLICIES_V1,
      ),
      compatibilityReleaseEpoch: fixture.release.epoch,
      compatibilityReleaseFingerprint: fixture.release.fingerprint,
    };
    expect(() =>
      parseWorkflowExecutableV2({
        envelope,
        admissionRelease: fixture.release,
      }),
    ).toThrow('workflow calls require executable V3 and source graph V2');
  });
});
