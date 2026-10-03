import { describe, expect, it } from 'vitest';

import {
  workflowCallableDraftRepresentationTagV2,
  workflowDraftRepresentationTag,
} from '../src/graph.js';

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
const input = {
  workflowId: '11111111-1111-4111-8111-111111111111',
  revision: 7,
  graph,
  compatibilityFingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};

describe('native callable draft representation identity', () => {
  it('uses an explicit strong V2 tag and canonical object ordering', () => {
    const tag = workflowCallableDraftRepresentationTagV2(input);
    expect(tag).toBe('"draft-v2.J3NHinfQgkXAeCZFZC7lK4ffa2Laze1r8RYFfAf4FLQ"');
    expect(tag).toMatch(/^"draft-v2\.[A-Za-z0-9_-]{43}"$/u);
    expect(
      workflowCallableDraftRepresentationTagV2({
        ...input,
        graph: {
          callable: graph.callable,
          settings: {},
          edges: [],
          nodes: [],
          schemaVersion: 2,
        },
      }),
    ).toBe(tag);
  });

  it('authenticates declaration, selector, compatibility, revision and workflow identity', () => {
    const tag = workflowCallableDraftRepresentationTagV2(input);
    const variants = [
      { ...input, workflowId: '22222222-2222-4222-8222-222222222222' },
      { ...input, revision: 8 },
      {
        ...input,
        compatibilityFingerprint: `${input.compatibilityFingerprint}:changed`,
      },
      {
        ...input,
        graph: { schemaVersion: 2, nodes: [], edges: [], settings: {} },
      },
      {
        ...input,
        graph: {
          ...graph,
          callable: {
            ...graph.callable,
            resultSelector: { kind: 'literal', value: { changed: true } },
          },
        },
      },
      {
        ...input,
        graph: {
          ...graph,
          callable: {
            ...graph.callable,
            input: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: [],
            },
          },
        },
      },
    ];
    for (const variant of variants)
      expect(workflowCallableDraftRepresentationTagV2(variant)).not.toBe(tag);
  });

  it('keeps both format owners fail closed across graph formats', () => {
    expect(() => workflowDraftRepresentationTag(input)).toThrow();
    expect(() =>
      workflowCallableDraftRepresentationTagV2({
        ...input,
        graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
      }),
    ).toThrow();
    expect(() =>
      workflowCallableDraftRepresentationTagV2({
        ...input,
        graph: { ...graph, unexpected: true },
      }),
    ).toThrow();
  });

  it('authenticates exact Call pins and editor position rather than executable-only material', () => {
    const call = {
      id: 'child',
      definition: { key: 'core.workflow_call', version: 1 },
      position: { x: 10, y: 20 },
      configVersion: 1,
      config: {
        workflowId: '22222222-2222-4222-8222-222222222222',
        versionId: '33333333-3333-4333-8333-333333333333',
        checksum: `wf:v3:sha256:${'b'.repeat(64)}`,
        callableContractIdentity: `callable:v1:sha256:${'c'.repeat(64)}`,
      },
      inputMappings: {},
      connectionRefs: {},
    };
    const pinned = { ...input, graph: { ...graph, nodes: [call] } };
    const tag = workflowCallableDraftRepresentationTagV2(pinned);
    for (const changed of [
      { ...call, position: { x: 11, y: 20 } },
      {
        ...call,
        config: {
          ...call.config,
          versionId: '44444444-4444-4444-8444-444444444444',
        },
      },
      {
        ...call,
        config: { ...call.config, checksum: `wf:v3:sha256:${'d'.repeat(64)}` },
      },
      {
        ...call,
        config: {
          ...call.config,
          callableContractIdentity: `callable:v1:sha256:${'e'.repeat(64)}`,
        },
      },
    ])
      expect(
        workflowCallableDraftRepresentationTagV2({
          ...pinned,
          graph: { ...graph, nodes: [changed] },
        }),
      ).not.toBe(tag);
  });
});
