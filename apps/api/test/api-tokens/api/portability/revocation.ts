import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';
import {
  workflowListResponseSchema,
  workflowRunStartResponseSchema,
  apiTokenCreateResponseSchema,
} from '@pertexo/contracts';
import type { createAutomationApiFixture } from '../fixture.js';
import type { TokenWorkspace } from './contract.js';
import type { qualifyCredentialRuns } from './runs.js';
import type { qualifyReviewedPortability } from './manifest.js';

export async function qualifyRoleRevocation(
  caseFixture: ReturnType<typeof createAutomationApiFixture>,
  evidence: TokenWorkspace &
    Awaited<ReturnType<typeof qualifyCredentialRuns>> &
    Awaited<ReturnType<typeof qualifyReviewedPortability>>,
) {
  const { api, listen } = caseFixture;
  const { email, workspaceId, base, workflowId, payload, started, copy } =
    evidence;
  const replacementOwner = randomUUID(),
    privateFolder = randomUUID();
  await api
    .database()
    .query('insert into app.users(id,email,display_name) values($1,$2,$3)', [
      replacementOwner,
      `${replacementOwner}@example.test`,
      'Remaining owner',
    ]);
  const membership = await api.database().connect();
  try {
    await membership.query('begin');
    await membership.query(
      "update app.workspace_memberships set role='builder',role_revision=role_revision+1 where workspace_id=$1",
      [workspaceId],
    );
    await membership.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
      [workspaceId, replacementOwner],
    );
    await membership.query('commit');
  } catch (error) {
    await membership.query('rollback');
    throw error;
  } finally {
    membership.release();
  }
  const fresh = await api.signIn(email);
  const issuedAfterRoleChange = await api.send('POST', `${base}/api-tokens`, {
    browser: fresh,
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      name: 'Builder resource scope',
      scopes: ['workflow:read', 'run:read', 'run:start'],
    },
  });
  expect(issuedAfterRoleChange.statusCode).toBe(201);
  const builderToken = apiTokenCreateResponseSchema.parse(
    issuedAfterRoleChange.json(),
  );
  if (builderToken.replayed)
    throw new Error('Expected a newly issued builder token');
  const builderHeaders = { authorization: `Bearer ${builderToken.secret}` };
  expect(
    (
      await api.send('GET', `${base}/workflows/${workflowId}`, {
        headers: builderHeaders,
      })
    ).statusCode,
  ).toBe(200);
  const builderKey = randomUUID();
  const builderStartedResponse = await api.send(
    'POST',
    `${base}/workflows/${workflowId}/runs`,
    {
      headers: { ...builderHeaders, 'idempotency-key': builderKey },
      payload,
    },
  );
  expect(builderStartedResponse.statusCode).toBe(202);
  const builderRun = workflowRunStartResponseSchema.parse(
    builderStartedResponse.json(),
  ).run;
  const streamAbort = new AbortController();
  const streamSignal = AbortSignal.any([
    streamAbort.signal,
    AbortSignal.timeout(15_000),
  ]);
  const stream = await fetch(
    `${await listen()}${base}/runs/${builderRun.id}/events`,
    { headers: { cookie: fresh.cookie }, signal: streamSignal },
  );
  expect(stream.status).toBe(200);
  const reader = stream.body?.getReader();
  if (!reader) throw new Error('Expected an authorized run stream');
  try {
    const firstFrame = await reader.read();
    expect(firstFrame.done).toBe(false);
    await api
      .database()
      .query(
        "insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values($1,$2,'Private source','private source','restricted')",
        [workspaceId, privateFolder],
      );
    await api
      .database()
      .query(
        'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3) on conflict(workspace_id,workflow_id) do update set folder_id=excluded.folder_id,revision=app.workflow_organization_state.revision+1',
        [workspaceId, workflowId, privateFolder],
      );
    for (const path of [
      `workflows/${workflowId}`,
      `workflows/${workflowId}/draft`,
      `workflows/${workflowId}/versions`,
      `runs/${started.run.id}`,
    ])
      expect(
        (
          await api.send('GET', `${base}/${path}`, {
            headers: builderHeaders,
          })
        ).statusCode,
      ).toBe(404);
    const visible = await api.send('GET', `${base}/workflows?limit=1`, {
      headers: builderHeaders,
    });
    expect(visible.statusCode).toBe(200);
    const visiblePage = workflowListResponseSchema.parse(visible.json());
    expect(visiblePage.items.map((item) => item.id)).toEqual([copy.workflowId]);
    expect(visiblePage.nextCursor ?? null).toBeNull();
    const replayAfterLoss = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/runs`,
      {
        headers: { ...builderHeaders, 'idempotency-key': builderKey },
        payload,
      },
    );
    expect(replayAfterLoss.statusCode).toBe(404);
    let closed = false;
    try {
      while (!(await reader.read()).done) {
        /* Drain only frames authorized before revocation. */
      }
      closed = true;
    } catch {
      // A server-initiated socket close and a clean EOF both revoke the stream.
      closed = !streamSignal.aborted;
    }
    expect(closed && !streamSignal.aborted).toBe(true);
  } finally {
    streamAbort.abort();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
