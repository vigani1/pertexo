import { randomUUID } from 'node:crypto';

import { apiProblemSchema } from '@pertexo/contracts';
import { expect, it } from 'vitest';

import { issueBrowserSession } from '../support/browser-session.fixture.js';

import {
  application,
  identityRuntime,
  ownerQuery,
  seedWebhook,
} from './fixture.js';

export function registerTellsClientWhenToRetrySetup(): void {
  it('answers a webhook still being set up with 409 and Retry-After: 5, and one already set up with no retry time', async () => {
    const seeded = await seedWebhook('setup-retry-after');
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seeded.actorId,
    );
    const provision = () =>
      application.inject({
        method: 'POST',
        url: `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/provision`,
        headers: {
          cookie: session.cookieHeader,
          'x-csrf-token': session.csrf,
          'idempotency-key': randomUUID(),
        },
      });

    const provisioned = await provision();
    expect(provisioned.statusCode, provisioned.body).toBe(409);
    expect(provisioned.headers['retry-after']).toBeUndefined();

    await ownerQuery(
      "update app.workflow_triggers set status='pending' where id=$1",
      [seeded.trigger.id],
    );
    const settingUp = await provision();
    expect(settingUp.statusCode, settingUp.body).toBe(409);
    expect(settingUp.headers['retry-after']).toBe('5');
    expect(settingUp.json()).toMatchObject({ code: 'workspace.conflict' });
    expect(apiProblemSchema.safeParse(settingUp.json()).success).toBe(true);
  });
}
