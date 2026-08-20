import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  WorkflowGraphContractError,
  safeParseWorkflowGraphDraft,
} from '../src/index.js';

describe('workflow-model package contract', () => {
  it('makes every export explicitly server-only', async () => {
    const json = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, { node: string; default: string }>;
      browser: Record<string, false>;
    };
    for (const value of Object.values(json.exports)) {
      expect(value.default).toBe(value.node);
      expect(json.browser[value.node]).toBe(false);
      const source = new URL(
        value.node.replace('./dist/', '../src/').replace(/\.js$/u, '.ts'),
        import.meta.url,
      );
      expect(await readFile(source, 'utf8')).toContain(
        "import './server-only.js';",
      );
    }
  });

  it('exposes only guarded graph parsing and safely rejects deeply nested input', async () => {
    let graph: Record<string, unknown> = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
    };
    for (let index = 0; index < 500; index += 1)
      graph = {
        schemaVersion: 1,
        nodes: [
          {
            id: `loop-${String(index)}`,
            definition: { key: 'core.loop', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            structured: {
              kind: 'for_each',
              maxIterations: 1,
              maxConcurrency: 1,
              body: { ...graph, inputPorts: [], outputPorts: [] },
            },
          },
        ],
        edges: [],
        settings: {},
      };

    const result = safeParseWorkflowGraphDraft(graph);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected typed parse failure');
    expect(result.error).toBeInstanceOf(WorkflowGraphContractError);
    expect(result.error).not.toBeInstanceOf(RangeError);

    const publicEntry = await import('../src/index.js');
    expect(publicEntry).not.toHaveProperty('WorkflowGraphInputSchemaV1');
  });
});
