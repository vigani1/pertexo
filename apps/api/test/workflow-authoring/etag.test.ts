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
    schemaVersion: 1,
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
    expect(first).toMatch(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);
  });

  it('changes when the selected representation or compatibility fingerprint changes', () => {
    const baseline = createDraftRepresentationTag(representation());
    expect(
      createDraftRepresentationTag(representation({ revision: 2 })),
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

  it('makes mixed current/target API replicas conservatively conflict', () => {
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
