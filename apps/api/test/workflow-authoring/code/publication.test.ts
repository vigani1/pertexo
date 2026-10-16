import { describe, expect, it } from 'vitest';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { codeStepPublicationIssues } from '../../../src/platform/workflow/code-validation.js';

const graph = (
  code = 'return input;',
  timeoutSeconds?: number,
): WorkflowGraph => ({
  nodes: [
    {
      id: 'code',
      position: { x: 0, y: 0 },
      configVersion: 1,
      inputMappings: {},
      connectionRefs: {},
      definition: { key: 'core.code', version: 1 },
      config: {
        code,
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      },
    },
  ],
  edges: [],
  settings: {},
});
describe('Code publication policy', () => {
  it('uses the source parser without executing an infinite loop', () => {
    expect(
      codeStepPublicationIssues(graph('while(true) {}'), DEFAULT_CODE_SETTINGS),
    ).toEqual([]);
  });
  it('refuses disabled steps and an instance timeout violation', () => {
    const disabled = codeStepPublicationIssues(graph(), {
      ...DEFAULT_CODE_SETTINGS,
      enabled: false,
    });
    expect(disabled[0]?.message).toContain('disabled');
    const timeout = codeStepPublicationIssues(
      graph('return input;', 31),
      DEFAULT_CODE_SETTINGS,
    );
    expect(timeout[0]?.path).toBe('$.nodes[0].config.timeoutSeconds');
    expect(timeout[0]?.message).toContain('30 seconds');
  });
  it('reports syntax positions from the same parser as the editor', () => {
    const issues = codeStepPublicationIssues(
      graph('return (;'),
      DEFAULT_CODE_SETTINGS,
    );
    expect(issues[0]?.path).toBe('$.nodes[0].config.code');
    expect(issues[0]?.message).toContain('Unexpected token');
  });
});
