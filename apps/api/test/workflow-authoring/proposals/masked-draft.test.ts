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
  definition: { key: 'ai.model', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: { [hiddenSetting]: hiddenValue },
  inputMappings: { prompt: { kind: 'literal', value: hiddenValue } },
  connectionRefs: { model_api_key: hiddenConnection },
};
const base: WorkflowGraph = { nodes: [protectedStep], edges: [], settings: {} };

describe('assistant draft masking', () => {
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
    expect(restoreDraftFields(base, candidate)).toEqual({
      kind: 'ready',
      graph: {
        ...base,
        nodes: [{ ...protectedStep, label: 'Extract the order' }],
      },
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
