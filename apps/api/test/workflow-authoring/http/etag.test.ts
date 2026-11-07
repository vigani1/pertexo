import { describe, expect, it } from 'vitest';

import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
type DraftRepresentation = Parameters<typeof workflowDraftRepresentationTag>[0];

const graph = {
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
    const first = workflowDraftRepresentationTag(representation());
    const second = workflowDraftRepresentationTag(
      representation({
        graph: { settings: {}, edges: [], nodes: [] },
      }),
    );
    expect(first).toBe(second);
    expect(first).toBe('"draft.xgc_YSdkqfFBrjRcOUbYwzd2P_MTeGBItWTRYx3XWB0"');
  });

  it('changes for workflow, revision, graph, or compatibility identity', () => {
    const baseline = workflowDraftRepresentationTag(representation());
    expect(
      workflowDraftRepresentationTag(
        representation({
          workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
      ),
    ).not.toBe(baseline);
    expect(
      workflowDraftRepresentationTag(representation({ revision: 2 })),
    ).not.toBe(baseline);
    expect(
      workflowDraftRepresentationTag(
        representation({
          graph: {
            ...graph,
            settings: { maxRunDurationMs: 1_000 },
          },
        }),
      ),
    ).not.toBe(baseline);
    expect(
      workflowDraftRepresentationTag(
        representation({
          compatibilityFingerprint:
            'wf-compat:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ),
    ).not.toBe(baseline);
  });
});
