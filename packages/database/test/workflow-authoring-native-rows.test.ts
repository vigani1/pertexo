import { describe, expect, it } from 'vitest';

import {
  mapDraft,
  mapVersion,
} from '../src/authoring/workflow-authoring-rows.js';

const id = '11111111-1111-4111-8111-111111111111';
const graph = {
  schemaVersion: 2,
  nodes: [],
  edges: [],
  settings: {},
  callable: {
    schemaVersion: 1,
    input: { type: 'object', properties: {}, required: [] },
    result: { type: 'object', properties: {}, required: [] },
    resultSelector: { kind: 'literal', value: {} },
  },
};
const draft = {
  workflow_id: id,
  workspace_id: id,
  revision: 7,
  schema_version: 2,
  graph_json: graph,
  updated_by: id,
  updated_at: '2026-10-03T00:00:00.000Z',
};
const version = {
  id,
  workspace_id: id,
  workflow_id: id,
  version_number: 1,
  schema_version: 2,
  graph_json: graph,
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  published_by: id,
  published_at: draft.updated_at,
};
const catalog = { schemaVersion: 1, definitions: [] } as const;

describe('explicit native authoring row formats', () => {
  it('preserves the native graph and declaration while projecting compatibility only', () => {
    const parsed = mapDraft(draft, catalog);
    expect(parsed.graphJson).toEqual(graph);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.compatibility).toMatchObject({
      compatible: true,
      issues: [],
    });
    expect(mapVersion(version)).toMatchObject({
      graphJson: graph,
      schemaVersion: 2,
      checksum: version.checksum,
    });
  });

  it.each([1, 2])(
    'rejects native graph paired with retained checksum V%s',
    (format) => {
      expect(() =>
        mapVersion({
          ...version,
          checksum: `wf:v${String(format)}:sha256:${'a'.repeat(64)}`,
        }),
      ).toThrow();
    },
  );

  it('rejects row/graph format substitution in both directions', () => {
    const retainedGraph = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
    };
    expect(() => mapDraft({ ...draft, schema_version: 1 }, catalog)).toThrow();
    expect(() =>
      mapDraft({ ...draft, graph_json: retainedGraph }, catalog),
    ).toThrow();
    expect(() => mapVersion({ ...version, schema_version: 1 })).toThrow();
    expect(() =>
      mapVersion({ ...version, schema_version: 1, graph_json: retainedGraph }),
    ).toThrow();
    expect(() =>
      mapVersion({ ...version, graph_json: retainedGraph }),
    ).toThrow();
    expect(() =>
      mapDraft({ ...draft, graph_json: { ...graph, injected: true } }, catalog),
    ).toThrow();
  });

  it('preserves retained graph V1 and checksum V2 without native promotion', () => {
    const retainedGraph = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
    };
    expect(
      mapDraft(
        { ...draft, schema_version: 1, graph_json: retainedGraph },
        catalog,
      ).graphJson,
    ).toEqual(retainedGraph);
    expect(
      mapVersion({
        ...version,
        schema_version: 1,
        graph_json: retainedGraph,
        checksum: `wf:v2:sha256:${'a'.repeat(64)}`,
      }).schemaVersion,
    ).toBe(1);
  });
});
