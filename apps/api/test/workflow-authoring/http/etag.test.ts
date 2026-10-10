import { describe, expect, it } from 'vitest';

import {
  createDraftRepresentationTag,
  type DraftRepresentation,
} from '../../../src/workflow-authoring/http/etag.js';

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
      'wf-compat:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
    expect(first).toBe('"draft.Z7MH4rsYnl9Ki-Rc1bSoVhtHnkmps60bHqTNgGtP8gE"');
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
            'wf-compat:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ),
    ).not.toBe(baseline);
  });
});
