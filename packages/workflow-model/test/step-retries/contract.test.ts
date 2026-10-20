import { describe, expect, it } from 'vitest';
import {
  parseWorkflowGraphDraft,
  stepRetrySettingsSchema,
  supportsStepRetrySettings,
  validateWorkflowGraph,
} from '../../src/index.js';

describe('step retry settings', () => {
  it.each([
    { maximumAttempts: 1, delayMillis: 1_000 },
    { maximumAttempts: 5, delayMillis: 60_000 },
  ])('accepts the bounded total tries and fixed wait: %o', (settings) => {
    expect(stepRetrySettingsSchema.parse(settings)).toEqual(settings);
  });
  it.each([
    { maximumAttempts: 0, delayMillis: 1_000 },
    { maximumAttempts: 6, delayMillis: 1_000 },
    { maximumAttempts: 2.5, delayMillis: 1_000 },
    { maximumAttempts: 3, delayMillis: 0 },
    { maximumAttempts: 3, delayMillis: 1_500 },
    { maximumAttempts: 3, delayMillis: 61_000 },
    {
      maximumAttempts: 3,
      delayMillis: 1_000,
      retryableErrorCodes: ['authentication'],
    },
  ])('refuses unsafe or unbounded overrides: %o', (settings) => {
    expect(stepRetrySettingsSchema.safeParse(settings).success).toBe(false);
  });
  it.each([
    'core.manual',
    'core.schedule',
    'core.webhook',
    'core.form',
    'core.workflow_error',
    'core.condition',
    'core.switch',
    'core.parallel',
    'core.merge',
    'core.foreach',
    'core.wait',
    'core.call',
    'core.terminate',
    'core.approval',
    'core.request_input',
  ])('refuses an override on %s', (key) => {
    const definition = { key, version: 1 };
    expect(supportsStepRetrySettings(definition)).toBe(false);
    const graph = parseWorkflowGraphDraft({
      settings: {},
      edges: [],
      nodes: [
        {
          id: 'step',
          definition,
          config: {},
          configVersion: 1,
          position: { x: 0, y: 0 },
          inputMappings: {},
          connectionRefs: {},
          retry: { maximumAttempts: 3, delayMillis: 1_000 },
        },
      ],
    });
    const checked = validateWorkflowGraph(graph);
    expect(checked.ok).toBe(false);
    expect(checked.issues).toContainEqual(
      expect.objectContaining({ path: '$.nodes.step.retry' }),
    );
  });
  it.each([
    'core.set',
    'core.read_file',
    'core.code',
    'http.request',
    'slack.post_message',
  ])('supports action %s without changing its safety class', (key) => {
    expect(supportsStepRetrySettings({ key, version: 1 })).toBe(true);
  });
});
