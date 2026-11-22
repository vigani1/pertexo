import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { isRecord } from '@pertexo/workflow-model';
import {
  fakeMcp,
  MCP_TOKEN,
  reply,
  TOOL_INPUT,
} from '../integrations/mcp/server.fixture.js';
import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import { waitForRunsToEnd } from '../support/recovery/facts.js';
import { httpChain } from '../support/recovery/graphs.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const headers = () => ({ 'idempotency-key': randomUUID() });
const waitLimit = 25_000;

describeFaults('an MCP tool used by a workflow', () => {
  let stack: Stack;
  let workspace: string;
  let otherWorkspace: string;
  beforeAll(async () => {
    stack = await startStack('mcp');
    workspace = await stack.api.createWorkspace('mcp-tools');
    otherWorkspace = await stack.api.createWorkspace('other-mcp-workspace');
  }, SCENARIO_LIMIT_MS);
  afterAll(async () => {
    await stack?.close();
  }, SCENARIO_LIMIT_MS);

  async function connection(endpoint: string) {
    const created = await stack.api.expect(201)(
      stack.api.call(
        'POST',
        `/v1/workspaces/${workspace}/connections`,
        {
          name: `MCP ${randomUUID()}`,
          providerKey: 'mcp',
          credential: { type: 'mcp_bearer', endpoint, token: MCP_TOKEN },
        },
        headers(),
      ),
    );
    if (!isRecord(created.json) || typeof created.json.id !== 'string')
      throw new Error('Connection response has no identifier');
    return created.json.id;
  }

  function lookup(connectionId: string, workspaceId = workspace) {
    return stack.api.call(
      'POST',
      `/v1/workspaces/${workspaceId}/connections/${connectionId}/lookup`,
      { providerKey: 'mcp', lookup: 'tools' },
    );
  }

  async function startTool(connectionId: string) {
    const flow = httpChain([]);
    const graph = {
      ...flow,
      nodes: [
        ...flow.nodes,
        {
          id: 'call',
          definition: { key: 'mcp.call-tool', version: 1 },
          position: { x: 100, y: 0 },
          configVersion: 1,
          config: { toolName: 'counter', toolInputSchema: TOOL_INPUT },
          inputMappings: { count: { kind: 'literal', value: 42 } },
          connectionRefs: { mcp_bearer: connectionId },
        },
      ],
      edges: [
        {
          id: 'call-edge',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'call', port: 'in' },
        },
      ],
    };
    const workflow = await stack.api.publish(workspace, 'Call counter', graph);
    return stack.api.startRun(workspace, workflow);
  }

  it('tests and discovers a tool without invoking it or sharing the connection with other workspaces', async () => {
    await using fake = await fakeMcp();
    const id = await connection(fake.url);
    expect((await lookup(id, otherWorkspace)).status).toBe(404);
    expect(fake.calls).toHaveLength(0);

    const test = await stack.api.call(
      'POST',
      `/v1/workspaces/${workspace}/connections/${id}/test`,
      { providerKey: 'mcp' },
      headers(),
    );
    expect(test.json).toMatchObject({ outcome: { ok: true } });
    const options = await lookup(id);
    expect(options.status).toBe(200);
    expect(options.json).toEqual({
      items: [{ value: 'counter', label: 'Counter', attach: TOOL_INPUT }],
    });
    expect(JSON.stringify(options.json)).not.toContain(MCP_TOKEN);
    expect(fake.calls.map(({ method }) => method)).not.toContain('tools/call');

    const revoked = await stack.api.call(
      'DELETE',
      `/v1/workspaces/${workspace}/connections/${id}`,
    );
    expect(revoked.status).toBe(200);
    const count = fake.calls.length;
    expect((await lookup(id)).status).toBe(409);
    expect(fake.calls).toHaveLength(count);
  });

  it('refuses redirects and excess results and ends a stalled lookup', async () => {
    await using target = await fakeMcp();
    await using redirect = await fakeMcp({
      initialize: (response) => {
        response.writeHead(307, { location: target.url }).end();
      },
    });
    await using tooMany = await fakeMcp({
      'tools/list': (response, request) => {
        reply(response, request, {
          tools: Array.from({ length: 101 }, (_, index) => ({
            name: `tool-${String(index)}`,
            inputSchema: { type: 'object' },
          })),
        });
      },
    });
    await using stalled = await fakeMcp({
      'tools/list': (response) => {
        response
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .flushHeaders();
      },
    });
    for (const endpoint of [redirect.url, tooMany.url, stalled.url]) {
      const result = await lookup(await connection(endpoint));
      expect(result.status).toBe(503);
      expect(result.json).toMatchObject({ code: 'provider.unavailable' });
    }
    expect(target.calls).toHaveLength(0);
    expect(stalled.calls.map(({ method }) => method)).not.toContain(
      'tools/call',
    );
  }, 40_000);

  it('records the mapped result through the run inspector API without credentials', async () => {
    await using fake = await fakeMcp();
    const runId = await startTool(await connection(fake.url));
    const facts = await waitForRunsToEnd(stack, [runId], waitLimit);
    expect(facts[runId]).toMatchObject({
      status: 'succeeded',
      steps: { call: ['succeeded'] },
    });
    const root = `/v1/workspaces/${workspace}/runs/${runId}`;
    const read = await stack.api.expect(200)(stack.api.call('GET', root));
    const { nodes } = read.json as { nodes: { nodeId: string; id: string }[] };
    const call = nodes.find(({ nodeId }) => nodeId === 'call');
    if (call === undefined) throw new Error('MCP run has no call step');
    const output = await stack.api.expect(200)(
      stack.api.call('GET', `${root}/node-runs/${call.id}/output`),
    );
    expect(output.json).toMatchObject({
      output: {
        kind: 'inline',
        value: { kind: 'structured', data: { count: 42 } },
      },
    });
    expect(JSON.stringify([read.json, output.json])).not.toContain(MCP_TOKEN);
  });

  it('keeps a tool call uncertain after worker loss and never calls it again', async () => {
    const accepted = Promise.withResolvers<void>();
    await using fake = await fakeMcp({
      'tools/call': () => {
        accepted.resolve();
      },
    });
    const runId = await startTool(await connection(fake.url));
    const signal = AbortSignal.timeout(waitLimit);
    await Promise.race([
      accepted.promise,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
    ]);
    await stack.worker.stop('SIGKILL');
    stack.worker.start();
    const facts = await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS);
    expect(facts[runId]).toMatchObject({
      status: 'outcome_unknown',
      steps: { call: ['outcome_unknown'] },
    });
    expect(
      fake.calls.filter(({ method }) => method === 'tools/call'),
    ).toHaveLength(1);
  });
});
