import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import {
  createCatalogServices,
  ListNodeDefinitionsService,
} from '../../../../src/catalog/catalog.service.js';
import { projectDraftForModel } from '../../../../src/workflow-authoring/proposals/masking/project-draft.js';
import { restoreDraftFields } from '../../../../src/workflow-authoring/proposals/masking/restore-draft.js';

const { assistantDisclosure } = createCatalogServices().listNodeDefinitions;
const project = (graph: WorkflowGraph) =>
  projectDraftForModel(graph, assistantDisclosure);
const restore = (graph: WorkflowGraph, candidate: WorkflowGraph) =>
  restoreDraftFields(graph, candidate, assistantDisclosure);

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
const headerStep: WorkflowNode = {
  ...protectedStep,
  config: {
    url: 'https://api.example.test/orders',
    headers: { 'X-Partner-Reference': hiddenValue },
  },
  inputMappings: {},
  connectionRefs: {},
};

describe('assistant draft masking', () => {
  it('shows the URL and protects each saved HTTP header record', () => {
    const graph = { ...base, nodes: [headerStep] };
    const projected = project(graph);
    expect(projected.nodes[0]?.config).toEqual({
      url: 'https://api.example.test/orders',
      headers: { kind: 'existing_setting' },
    });
    const candidate = {
      ...projected,
      nodes: [
        {
          ...headerStep,
          config: {
            url: 'https://api.example.test/v2/orders',
            headers: { kind: 'existing_setting' },
          },
        },
      ],
    };
    const restored = restore(graph, candidate);
    if (restored.kind !== 'ready') throw new Error('Expected an editable URL');
    expect(restored.graph).toEqual({
      ...graph,
      nodes: [
        {
          ...headerStep,
          config: {
            ...headerStep.config,
            url: 'https://api.example.test/v2/orders',
          },
        },
      ],
    });
  });

  it('withholds protected keys and values while preserving them across a label change', () => {
    const projected = project(base);
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
    const restored = restore(base, candidate);
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
    const projected = project(graph);
    expect(projected.nodes[0]?.config.url).toEqual({
      kind: 'existing_setting',
    });
    expect(JSON.stringify(projected)).not.toContain(hiddenValue);
  });

  it('refuses a query string added to a saved visible address', () => {
    const graph = { ...base, nodes: [headerStep] };
    const projected = project(graph);
    const candidate = {
      ...projected,
      nodes: projected.nodes.map((node) => ({
        ...node,
        config: {
          ...node.config,
          url: 'https://api.example.test/orders?key=added-by-model',
        },
      })),
    };
    expect(restore(graph, candidate)).toMatchObject({
      kind: 'rejected',
      issues: [
        {
          code: 'masked_value_added',
          path: '$.nodes.extract.config.url',
        },
      ],
      feedback: [{ code: 'masked_value_added' }],
    });
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
    const projected = project(graph);
    expect(JSON.stringify(projected)).not.toContain(hiddenSetting);
    expect(JSON.stringify(projected)).not.toContain(hiddenValue);
    const restored = restore(graph, projected);
    if (restored.kind !== 'ready')
      throw new Error('Expected an unchanged draft');
    expect(restored.graph).toEqual(graph);
  });

  it('keeps a step saved under an older config version opaque and restores it unchanged', () => {
    const real = platformBrowserNodeDefinitionCatalog();
    const upgraded = new ListNodeDefinitionsService(
      {
        definitions: real.definitions.map((definition) =>
          definition.definition.key === 'http.request'
            ? { ...definition, configVersion: 2 }
            : definition,
        ),
      },
      undefined,
      new Map(
        real.definitions.flatMap(({ definition }) => {
          const disclosure = assistantDisclosure({
            definition,
            configVersion: 1,
          });
          return disclosure === undefined
            ? []
            : [[`${definition.key}@${String(definition.version)}`, disclosure]];
        }),
      ),
    );
    const graph = { ...base, nodes: [headerStep] };
    const projected = projectDraftForModel(graph, upgraded.assistantDisclosure);
    expect(projected.nodes[0]?.config).toEqual({
      '@existing': { kind: 'existing_setting' },
    });
    expect(JSON.stringify(projected)).not.toContain('api.example.test');
    const restored = restoreDraftFields(
      graph,
      projected,
      upgraded.assistantDisclosure,
    );
    if (restored.kind !== 'ready')
      throw new Error('Expected an unchanged draft');
    expect(restored.graph).toEqual(graph);
  });

  it('masks and restores the settings of a step inside a For Each body', () => {
    const loop: WorkflowNode = {
      id: 'loop',
      definition: { key: 'core.foreach', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: { items: { kind: 'literal', value: [1, 2] } },
      connectionRefs: {},
      structured: {
        kind: 'for_each',
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          settings: {},
          nodes: [headerStep],
          edges: [],
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    };
    const graph = { ...base, nodes: [loop] };
    const projected = project(graph);
    const body = projected.nodes[0]?.structured?.body.nodes ?? [];
    expect(body[0]?.config).toEqual({
      url: 'https://api.example.test/orders',
      headers: { kind: 'existing_setting' },
    });
    expect(JSON.stringify(projected)).not.toContain(hiddenValue);
    const withBody = (config: WorkflowNode['config']) => ({
      ...projected,
      nodes: projected.nodes.map((node) =>
        node.structured === undefined
          ? node
          : {
              ...node,
              structured: {
                ...node.structured,
                body: {
                  ...node.structured.body,
                  nodes: node.structured.body.nodes.map((child) => ({
                    ...child,
                    config,
                  })),
                },
              },
            },
      ),
    });
    const edited = restore(
      graph,
      withBody({
        url: 'https://api.example.test/v2/orders',
        headers: { kind: 'existing_setting' },
      }),
    );
    if (edited.kind !== 'ready') throw new Error('Expected an editable URL');
    expect(edited.graph.nodes[0]?.structured?.body.nodes[0]?.config).toEqual({
      url: 'https://api.example.test/v2/orders',
      headers: { 'X-Partner-Reference': hiddenValue },
    });
    expect(
      restore(
        graph,
        withBody({
          url: 'https://api.example.test/orders',
          headers: { 'X-Partner-Reference': 'changed-by-model' },
        }),
      ),
    ).toMatchObject({
      kind: 'rejected',
      issues: [
        {
          code: 'masked_value_changed',
          path: '$.nodes.loop.structured.body.nodes.extract.config.headers',
        },
      ],
    });
  });

  it('lets the model set masked fields on a step it adds, and leaves their issues correctable', () => {
    const added: WorkflowNode = {
      ...headerStep,
      id: 'added',
      config: {
        url: 'https://api.example.test/orders',
        headers: { 'X-Trace': 'value-from-model' },
      },
    };
    const restored = restore(
      { ...base, nodes: [] },
      { ...base, nodes: [added] },
    );
    if (restored.kind !== 'ready') throw new Error('Expected a new step');
    expect(restored.graph.nodes).toEqual([added]);
    expect(restored.protectedPaths).not.toContainEqual(
      expect.stringContaining('$.nodes.added'),
    );
    expect(restored.protectedPaths).not.toContainEqual(
      expect.stringContaining('$.nodes[0]'),
    );
  });

  it('refuses a placeholder copied onto a step the model adds', () => {
    const added: WorkflowNode = {
      ...headerStep,
      id: 'added',
      config: {
        url: 'https://api.example.test/orders',
        headers: { kind: 'existing_setting' },
      },
    };
    expect(
      restore({ ...base, nodes: [] }, { ...base, nodes: [added] }),
    ).toMatchObject({
      kind: 'rejected',
      issues: [
        {
          code: 'masked_placeholder_copied',
          path: '$.nodes.added.config.headers',
        },
      ],
      feedback: [{ code: 'masked_placeholder_copied' }],
    });
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
    const projected = project({ ...base, nodes: [node] });
    expect(projected.nodes[0]?.config).toEqual({
      model: 'test-model',
      tools: { kind: 'existing_setting' },
    });
  });

  it('refuses to remove a step, change its definition or clear its protected settings', () => {
    const projected = project(base);
    for (const nodes of [
      [],
      projected.nodes.map((node) => ({
        ...node,
        definition: { key: 'core.set', version: 1 },
      })),
      projected.nodes.map((node) => ({ ...node, config: {} })),
    ]) {
      expect(restore(base, { ...projected, nodes })).toMatchObject({
        kind: 'rejected',
        issues: [expect.objectContaining({ code: 'masked_value_changed' })],
      });
    }
  });
});
