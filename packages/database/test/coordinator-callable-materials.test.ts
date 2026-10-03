import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadCoordinatorCallableMaterials } from '../src/execution/coordinator/coordinator-callable-materials.js';

const workspace = '00000000-0000-4000-8000-000000000101';
const run = '00000000-0000-4000-8000-000000000201';
const attempt = '00000000-0000-4000-8000-000000000301';
const type = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
};
const inline = (value: unknown) => ({
  schemaVersion: 1,
  kind: 'inline',
  value,
});
function input(selector: unknown = { kind: 'run_input', path: '$' }) {
  return {
    workspaceId: workspace,
    runId: run,
    inputRef: inline({ name: 'input' }),
    facts: [],
    executableJson: {
      schemaVersion: 3,
      graph: {
        nodes: [{ id: 'result' }],
        callable: {
          schemaVersion: 1,
          input: type,
          result: type,
          resultSelector: selector,
        },
      },
    },
  };
}
function client(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as PoolClient;
}

describe('native callable inline completion hydration', () => {
  it('loads run-input results without unrelated physical output queries', async () => {
    const query = vi.fn();
    await expect(
      loadCoordinatorCallableMaterials(client(query), input()),
    ).resolves.toEqual({ runInput: { name: 'input' }, outputs: [] });
    expect(query).not.toHaveBeenCalled();
  });
  it('leaves literal results with the pure existing completion owner', async () => {
    const query = vi.fn();
    await expect(
      loadCoordinatorCallableMaterials(
        client(query),
        input({ kind: 'literal', value: { name: 'literal' } }),
      ),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
  it('binds selected node values to the real succeeded physical attempt', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            invocation_key: 'result-key',
            node_id: 'result',
            attempt_id: attempt,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ attempt_id: attempt, output_ref: inline({ name: 'output' }) }],
      });
    await expect(
      loadCoordinatorCallableMaterials(
        client(query),
        input({ kind: 'node_output', nodeId: 'result', path: '$' }),
      ),
    ).resolves.toEqual({
      runInput: null,
      outputs: [
        {
          invocationKey: 'result-key',
          output: { kind: 'inline', attemptId: attempt },
          value: { name: 'output' },
        },
      ],
    });
    expect(query.mock.calls[0]?.[1]).toEqual([workspace, run, ['result']]);
    expect(query.mock.calls[1]?.[1]).toEqual([workspace, run, [attempt]]);
  });
  it('preserves the engine-owned ambiguous-source failure without hydrating either value', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { invocation_key: 'left', node_id: 'result', attempt_id: attempt },
        { invocation_key: 'right', node_id: 'result', attempt_id: run },
      ],
    });
    await expect(
      loadCoordinatorCallableMaterials(
        client(query),
        input({ kind: 'node_output', nodeId: 'result', path: '$' }),
      ),
    ).resolves.toEqual({ runInput: null, outputs: [] });
    expect(query).toHaveBeenCalledOnce();
  });
  it('rejects a physical reference lost between bounded metadata and value reads', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            invocation_key: 'result-key',
            node_id: 'result',
            attempt_id: attempt,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      loadCoordinatorCallableMaterials(
        client(query),
        input({ kind: 'node_output', nodeId: 'result', path: '$' }),
      ),
    ).rejects.toThrow();
  });
  it('does not silently turn an artifact into an inline value', async () => {
    const query = vi.fn();
    await expect(
      loadCoordinatorCallableMaterials(client(query), {
        ...input(),
        inputRef: { schemaVersion: 1, kind: 'artifact', artifactId: attempt },
      }),
    ).rejects.toThrow('artifact hydration is unavailable');
    expect(query).not.toHaveBeenCalled();
  });
  it('hydrates a just-terminal child through its protected result before logical Call settlement', async () => {
    const value = { name: 'child' };
    const bytes = JSON.stringify(value);
    const fact = {
      status: 'settled' as const,
      childStatus: 'succeeded' as const,
      childRunId: run,
      invocationKey: 'call-key',
      nodeId: 'result',
      declarationAttemptId: attempt,
      inputChecksum: 'a'.repeat(64),
      input: { kind: 'inline' as const, attemptId: attempt },
      pin: {
        workflowId: workspace,
        versionId: workspace,
        checksum: `wf:v3:sha256:${'b'.repeat(64)}`,
        callableContractIdentity: `callable:v1:sha256:${'c'.repeat(64)}`,
      },
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            reference_json: JSON.stringify(inline(value)),
            serialized_value: bytes,
            byte_length: Buffer.byteLength(bytes),
            value_checksum: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      });
    await expect(
      loadCoordinatorCallableMaterials(client(query), {
        ...input({ kind: 'node_output', nodeId: 'result', path: '$' }),
        facts: [fact],
      }),
    ).resolves.toEqual({
      runInput: null,
      outputs: [
        {
          invocationKey: 'call-key',
          output: {
            kind: 'workflow_call',
            invocationKey: 'call-key',
            childRunId: run,
          },
          value,
        },
      ],
    });
    expect(query.mock.calls[1]?.[0]).toContain(
      'app.read_workflow_call_result_reference',
    );
    expect(query.mock.calls[1]?.[1]).toEqual([run, 'call-key', run]);
  });
  it('reads selected physical values in bounded pages', async () => {
    const rows = Array.from({ length: 17 }, (_, index) => ({
      invocation_key: `source-${String(index)}`,
      node_id: `node${String(index)}`,
      attempt_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
    const values = rows.map((row) => ({
      attempt_id: row.attempt_id,
      output_ref: inline({ name: row.node_id }),
    }));
    const source = input({
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: 'nodeOutputs',
    });
    source.executableJson.graph.nodes = rows.map((row) => ({
      id: row.node_id,
    }));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: values.slice(0, 16) })
      .mockResolvedValueOnce({ rows: values.slice(16) });
    const result = await loadCoordinatorCallableMaterials(
      client(query),
      source,
    );
    expect(result?.outputs).toHaveLength(17);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[1]).toEqual([
      workspace,
      run,
      rows.slice(0, 16).map((row) => row.attempt_id),
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      workspace,
      run,
      rows.slice(16).map((row) => row.attempt_id),
    ]);
  });
});
