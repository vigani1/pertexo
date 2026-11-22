import { expect, it } from 'vitest';
import { publishGraph, type StackOwner } from '../support/real-stack/owner.js';
import type { mcpClient } from './client.js';
import { expose } from './exposure.js';

type Token = Readonly<{ client: ReturnType<typeof mcpClient> }>;

export function mcpAdmissionCases({
  getWorkspace,
  getToken,
  stopWorker,
  credential,
  runsOf,
  graph,
}: Readonly<{
  getWorkspace: () => StackOwner;
  getToken: () => Token;
  stopWorker: () => Promise<void>;
  credential: (workspace: StackOwner, name: string) => Promise<Token>;
  runsOf: (workflowId: string) => Promise<readonly unknown[]>;
  graph: Parameters<typeof publishGraph>[2];
}>) {
  it('enforces real run capacity and token rate limits independently', async () => {
    const workflow = await publishGraph(getWorkspace(), 'Capacity tool', graph);
    await expose(getWorkspace(), workflow, 'capacity_tool');
    await stopWorker();
    const { client } = getToken();
    expect(
      (await client.invoke('capacity_tool', { name: 'One' }, { waitMillis: 0 }))
        .isError,
    ).toBe(false);
    expect(
      (await client.invoke('capacity_tool', { name: 'Two' }, { waitMillis: 0 }))
        .isError,
    ).toBe(false);
    const full = await client.call('capacity_tool', { name: 'Three' });
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({
      code: 'workspace.quota_exceeded',
    });
    const calls = await Promise.all(
      Array.from({ length: 21 }, () => client.call('missing', {})),
    );
    const limited = calls.find((reply) => reply.status === 429);
    expect(limited).toBeDefined();
    expect(await limited?.json()).toMatchObject({
      code: 'request.rate_limited',
    });
    const clients = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        credential(getWorkspace(), `Workspace limit client ${String(index)}`),
      ),
    );
    let workspaceLimited = false;
    for (const { client } of clients) {
      const sent = await Promise.all(
        Array.from({ length: 20 }, () => client.call('missing', {})),
      );
      for (const response of sent) {
        if (response.status === 429) {
          expect(await response.json()).toMatchObject({
            code: 'request.rate_limited',
          });
          workspaceLimited = true;
        }
      }
    }
    expect(workspaceLimited).toBe(true);
    expect((await client.list()).tools.map(({ name }) => name)).toContain(
      'capacity_tool',
    );
    expect(await runsOf(workflow.workflowId)).toHaveLength(2);
  });
}
