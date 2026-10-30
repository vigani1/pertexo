import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { apiQuery, ownerQuery, seedWebhook, sendWebhook } from './fixture.js';

export function registerRefusesWebhooksOutsideActiveWorkspace(): void {
  it('takes a webhook only while the workspace is active', async () => {
    const { endpointKey, originalSecret, workspaceId } =
      await seedWebhook('workspace-state');
    const deliver = () =>
      sendWebhook(endpointKey, originalSecret, Buffer.from('{}'), randomUUID());
    const runs = async () =>
      (
        await apiQuery<{ runs: number }>(
          `select count(*)::int runs from app.workflow_runs where workspace_id=$1`,
          [workspaceId],
        )
      ).rows[0]?.runs;

    expect((await deliver()).status).toBe(202);
    expect(await runs()).toBe(1);

    await ownerQuery(
      `update app.workspaces set status='suspended' where id=$1`,
      [workspaceId],
    );
    // Unknown and closed endpoints answer alike, so the state isn't disclosed.
    expect((await deliver()).status).toBe(401);
    expect(await runs()).toBe(1);
  });
}
