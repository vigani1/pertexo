import { MCP_STATUS_TOOL_NAME } from '@pertexo/contracts';
import { expect, it } from 'vitest';
import {
  publishGraph,
  step,
  type StackOwner,
} from '../support/real-stack/owner.js';
import { expose, readExposure } from './exposure.js';

type Graph = Parameters<typeof publishGraph>[2] &
  Readonly<{ callable: object }>;

export function mcpExposureCases(getOwner: () => StackOwner, graph: Graph) {
  it('reserves the status name and refuses duplicate tool names in the workspace', async () => {
    const owner = getOwner();
    const first = await publishGraph(owner, 'Unique tool', graph);
    const second = await publishGraph(owner, 'Duplicate tool', graph);
    await expose(owner, first, 'unique_tool');
    const attempt = (name: string) =>
      owner.send('PUT', `${second.path}/mcp`, {
        kind: 'expose',
        name,
        description: 'Return the greeting.',
        expectedVersionId: second.versionId,
        expectedRevision: null,
      });
    expect((await attempt('unique_tool')).status).toBe(409);
    expect((await attempt(MCP_STATUS_TOOL_NAME)).status).toBe(400);
    expect((await readExposure(owner, second.path)).exposure).toBeNull();
  });

  it('exposes a JSON-body webhook entry and refuses an entry that needs the HTTP request envelope', async () => {
    const owner = getOwner();
    const body = await publishGraph(owner, 'Webhook body tool', {
      ...graph,
      nodes: [step('webhook', 'core.webhook', 0)],
    });
    await expose(owner, body, 'webhook_tool');
    const headers = await publishGraph(owner, 'Webhook request envelope', {
      ...graph,
      nodes: [step('webhook', 'core.webhook', 0, { runInput: 'request' })],
    });
    expect((await readExposure(owner, headers.path)).eligible).toBe(false);
    const refused = await owner.send('PUT', `${headers.path}/mcp`, {
      kind: 'expose',
      name: 'request_tool',
      description: 'Requires the original request.',
      expectedVersionId: headers.versionId,
      expectedRevision: null,
    });
    expect(refused.status).toBe(409);
  });
}
