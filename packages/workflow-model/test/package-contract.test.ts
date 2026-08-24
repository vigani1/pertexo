import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  WorkflowGraphContractError,
  safeParseWorkflowGraphDraft,
} from '../src/index.js';
import { workflowGraphSchema } from '../src/graph-contract.js';

describe('workflow-model package contract', () => {
  it('keeps canonical graph ownership browser-safe while server implementation exports remain protected', async () => {
    const json = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      exports: Record<
        string,
        { types: string; node?: string; default: string }
      >;
      browser: Record<string, false>;
    };
    expect(json.dependencies).not.toHaveProperty('@pertexo/contracts');
    const graphContract = json.exports['./graph-contract'];
    if (graphContract === undefined)
      throw new Error('missing browser-safe graph contract export');
    expect(graphContract).toEqual({
      types: './dist/graph-contract.d.ts',
      default: './dist/graph-contract.js',
    });
    expect(json.browser[graphContract.default]).toBeUndefined();
    expect(
      await readFile(
        new URL('../src/graph-contract.ts', import.meta.url),
        'utf8',
      ),
    ).not.toMatch(/(?:from|import) ['"](?:node:|@pertexo\/contracts)/u);

    for (const [name, value] of Object.entries(json.exports)) {
      if (name === './graph-contract' || name === './failure-notification')
        continue;
      if (value.node === undefined)
        throw new Error(`server export ${name} is missing its node target`);
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

    expect(() => workflowGraphSchema.safeParse(graph)).not.toThrow(RangeError);
    expect(workflowGraphSchema.safeParse(graph).success).toBe(false);

    const publicEntry = await import('../src/index.js');
    expect(publicEntry).not.toHaveProperty('WorkflowGraphInputSchemaV1');
  });
});
