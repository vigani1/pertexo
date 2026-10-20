import { describe, expect, it, vi } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  describeStepRetrySettings,
  retrySettingsForMode,
  shownRetrySettings,
  stepRetryForm,
  stepRetryMode,
} from '@/features/workflow-editor/model/inspector/retries/draft';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import { updateWorkflowNode } from '@/features/workflow-editor/model/graph/commands';

const action: WorkflowGraphContract['nodes'][number] = {
  id: 'step',
  definition: { key: 'core.set', version: 1 },
  configVersion: 1,
  position: { x: 0, y: 0 },
  config: { preserved: true },
  inputMappings: {},
  connectionRefs: {},
};
describe('step retry setup', () => {
  it('distinguishes defaults, no retries and custom without storing default overrides', () => {
    expect(stepRetryMode(action.retry)).toBe('default');
    const none = retrySettingsForMode('none', action);
    expect(none).toEqual({ maximumAttempts: 1, delayMillis: 1_000 });
    expect(stepRetryMode(none)).toBe('none');
    expect(retrySettingsForMode('custom', { ...action, retry: none })).toEqual({
      maximumAttempts: 3,
      delayMillis: 1_000,
    });
    expect(
      retrySettingsForMode('default', { ...action, retry: none }),
    ).toBeUndefined();
  });
  it.each([
    [
      undefined,
      'Up to three total tries for eligible failures, with increasing waits and jitter.',
    ],
    [
      { maximumAttempts: 1, delayMillis: 1_000 },
      'One try. Temporary failures are not retried.',
    ],
    [
      { maximumAttempts: 5, delayMillis: 1_000 },
      'Up to 5 total tries for eligible failures, waiting 1 second between tries.',
    ],
    [
      { maximumAttempts: 4, delayMillis: 3_000 },
      'Up to 4 total tries for eligible failures, waiting 3 seconds between tries.',
    ],
  ] as const)('describes the selected limit and wait: %o', (settings, text) => {
    expect(describeStepRetrySettings(settings)).toBe(text);
  });
  it('edits current settings, preserves sibling edits, and namespaces scratch', () => {
    let current = {
      ...action,
      retry: { maximumAttempts: 3, delayMillis: 1_000 },
    };
    const scratch = vi.fn();
    const form: NodeFormApi = {
      nodeId: action.id,
      editable: true,
      reportScratch: scratch,
      commit: (input) => {
        current = {
          ...current,
          ...(typeof input === 'function' ? input(current) : input),
        } as typeof current;
      },
    };
    const fields = stepRetryForm(form);
    current = {
      ...current,
      config: { newer: true },
      retry: { maximumAttempts: 5, delayMillis: 10_000 },
    };
    fields.commit(
      (node) => ({ config: { ...node.config, delaySeconds: 2 } }),
      'wait',
    );
    expect(current.config).toEqual({ newer: true });
    expect(current.retry).toEqual({ maximumAttempts: 5, delayMillis: 2_000 });
    expect(shownRetrySettings(current)).toEqual({
      maximumAttempts: 5,
      delaySeconds: 2,
    });
    fields.reportScratch('delaySeconds', true);
    expect(scratch).toHaveBeenCalledWith('retry:delaySeconds', true);
  });
  it('removes the field when restoring defaults, without changing the rest of the draft', () => {
    const graph = {
      nodes: [{ ...action, retry: { maximumAttempts: 1, delayMillis: 1_000 } }],
      edges: [],
      settings: {},
    };
    const restored = updateWorkflowNode(graph, action.id, { retry: undefined });
    expect(restored.nodes[0]).toEqual(action);
    const node = restored.nodes[0];
    if (node === undefined) throw new Error('The restored action must exist');
    expect(Object.hasOwn(node, 'retry')).toBe(false);
    expect(updateWorkflowNode(restored, action.id, { retry: undefined })).toBe(
      restored,
    );
  });
});
