import { describe, expect, it } from 'vitest';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import { composeExecutableCompatibilityRelease } from '@pertexo/workflow-engine';

import {
  createDraftRepresentationTag,
  type DraftRepresentation,
} from '../../src/workflow-authoring/etag.js';

const graph = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
} as const;

function representation(
  overrides: Partial<DraftRepresentation> = {},
): DraftRepresentation {
  return {
    workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    revision: 1,
    graph,
    compatibilityFingerprint:
      'wf-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...overrides,
  };
}

describe('workflow authoring strong draft ETag', () => {
  it('is deterministic for equivalent object key order and quoted as a strong tag', () => {
    const first = createDraftRepresentationTag(representation());
    const second = createDraftRepresentationTag(
      representation({
        graph: { settings: {}, edges: [], nodes: [], schemaVersion: 1 },
      }),
    );
    expect(first).toBe(second);
    expect(first).toBe(
      '"draft-v1.xzaPxyaUKr6H4jU2nHgNO0qYBq8iqqmHnSPCfbYc7Qk"',
    );
  });

  it('changes for workflow, revision, graph, or compatibility identity', () => {
    const baseline = createDraftRepresentationTag(representation());
    expect(
      createDraftRepresentationTag(
        representation({
          workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
      ),
    ).not.toBe(baseline);
    expect(
      createDraftRepresentationTag(representation({ revision: 2 })),
    ).not.toBe(baseline);
    expect(
      createDraftRepresentationTag(
        representation({
          graph: {
            ...graph,
            settings: { maxRunDurationMs: 1_000 },
          },
        }),
      ),
    ).not.toBe(baseline);
    expect(
      createDraftRepresentationTag(
        representation({
          compatibilityFingerprint:
            'wf-compat:v1:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ),
    ).not.toBe(baseline);
  });

  it('assigns distinct tags to current and target compatibility projections', () => {
    const current = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE,
    );
    const target = composeExecutableCompatibilityRelease(
      createRegistryReleaseSuccessor({
        previous: CORE_REGISTRY_RELEASE,
        epoch: CORE_REGISTRY_RELEASE.epoch + 1,
        definitions: CORE_REGISTRY_RELEASE.definitions.map((manifest) => ({
          ...manifest,
          lifecycle:
            manifest.definition.key === 'core.manual'
              ? ('deprecated' as const)
              : manifest.lifecycle,
        })),
        executors: CORE_REGISTRY_RELEASE.executors,
        policies: CORE_REGISTRY_RELEASE.policies,
      }),
    );

    expect(
      createDraftRepresentationTag(
        representation({ compatibilityFingerprint: current.fingerprint }),
      ),
    ).not.toBe(
      createDraftRepresentationTag(
        representation({ compatibilityFingerprint: target.fingerprint }),
      ),
    );
  });
});
