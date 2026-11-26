import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import {
  projectDraftForModel,
  restoreDraftFields,
} from '../../../src/workflow-authoring/proposals/masked-draft.js';

const hiddenSetting = 'sentinel-in-a-setting-key';
const hiddenValue = 'sentinel-in-a-setting-value';
const hiddenConnection = 'sentinel-connection-id';
const protectedStep: WorkflowNode = {
  id: 'extract',
  definition: { key: 'http.request', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: { [hiddenSetting]: hiddenValue },
  inputMappings: { body: { kind: 'literal', value: hiddenValue } },
  connectionRefs: { model_api_key: hiddenConnection },
};
const base: WorkflowGraph = { nodes: [protectedStep], edges: [], settings: {} };

describe('assistant draft masking', () => {
  it('shows the URL and protects each saved HTTP header record', () => {
    const node: WorkflowNode = {
      ...protectedStep,
      definition: { key: 'http.request', version: 1 },
      config: {
        url: 'https://api.example.test/orders',
        headers: { Authorization: hiddenValue },
      },
      inputMappings: {},
    };
    const graph = { ...base, nodes: [node] };
    const projected = projectDraftForModel(graph);
    expect(projected.nodes[0]?.config).toEqual({
      url: 'https://api.example.test/orders',
      headers: { kind: 'existing_setting' },
    });
    const candidate = {
      ...projected,
      nodes: [
        {
          ...node,
          config: {
            url: 'https://api.example.test/v2/orders',
            headers: { kind: 'existing_setting' },
          },
          connectionRefs: projected.nodes[0]?.connectionRefs ?? {},
        },
      ],
    };
    const restored = restoreDraftFields(graph, candidate);
    if (restored.kind !== 'ready') throw new Error('Expected an editable URL');
    expect(restored.graph).toEqual({
      ...graph,
      nodes: [
        {
          ...node,
          config: { ...node.config, url: 'https://api.example.test/v2/orders' },
        },
      ],
    });
  });

  it('withholds protected keys and values while preserving them across a label change', () => {
    const projected = projectDraftForModel(base);
    const serialized = JSON.stringify(projected);
    for (const hidden of [hiddenSetting, hiddenValue, hiddenConnection])
      expect(serialized).not.toContain(hidden);
    const candidate = {
      ...projected,
      nodes: projected.nodes.map((node) => ({
        ...node,
        label: 'Extract the order',
      })),
    };
    const restored = restoreDraftFields(base, candidate);
    if (restored.kind !== 'ready')
      throw new Error('Expected an editable label');
    expect(restored.graph).toEqual({
      ...base,
      nodes: [{ ...protectedStep, label: 'Extract the order' }],
    });
  });

  it('protects query strings within a saved address', () => {
    const node: WorkflowNode = {
      ...protectedStep,
      config: { url: `https://api.example.test/orders?key=${hiddenValue}` },
    };
    const graph = { ...base, nodes: [node] };
    const projected = projectDraftForModel(graph);
    expect(projected.nodes[0]?.config.url).toEqual({
      kind: 'existing_setting',
    });
    expect(JSON.stringify(projected)).not.toContain(hiddenValue);
  });

  it('keeps all settings and mappings opaque when a definition has no disclosure', () => {
    const node: WorkflowNode = {
      ...protectedStep,
      definition: { key: 'community.acme.legacy', version: 1 },
      config: { [hiddenSetting]: hiddenValue },
      inputMappings: {
        [hiddenSetting]: { kind: 'literal', value: hiddenValue },
      },
    };
    const graph = { ...base, nodes: [node] };
    const projected = projectDraftForModel(graph);
    expect(JSON.stringify(projected)).not.toContain(hiddenSetting);
    expect(JSON.stringify(projected)).not.toContain(hiddenValue);
    const restored = restoreDraftFields(graph, projected);
    if (restored.kind !== 'ready')
      throw new Error('Expected an unchanged draft');
    expect(restored.graph).toEqual(graph);
  });

  it('protects the audience of an approval inside an Agent tool', () => {
    const node: WorkflowNode = {
      ...protectedStep,
      definition: { key: 'ai.agent', version: 3 },
      config: {
        model: 'test-model',
        tools: [
          {
            writePermission: {
              kind: 'approval',
              config: { audience: { memberIds: [hiddenValue] } },
            },
          },
        ],
      },
    };
    const projected = projectDraftForModel({ ...base, nodes: [node] });
    expect(projected.nodes[0]?.config).toEqual({
      model: 'test-model',
      tools: { kind: 'existing_setting' },
    });
  });

  it('refuses to remove a step, change its definition or clear its protected settings', () => {
    const projected = projectDraftForModel(base);
    for (const nodes of [
      [],
      projected.nodes.map((node) => ({
        ...node,
        definition: { key: 'core.set', version: 1 },
      })),
      projected.nodes.map((node) => ({ ...node, config: {} })),
    ]) {
      expect(restoreDraftFields(base, { ...projected, nodes })).toMatchObject({
        kind: 'rejected',
        issues: [expect.objectContaining({ code: 'masked_value_changed' })],
      });
    }
  });
});
