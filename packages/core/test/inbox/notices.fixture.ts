import { withTenantScopedClient } from '@pertexo/database/primitives';
import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import {
  identity,
  apiUrl,
  apiPool,
  dispatcherUrl,
  queryAsOwner,
} from '../support/workflow-authoring.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createWorkspaceInboxFoldStore } from '../../src/inbox/folding/store.js';
import { createWorkspaceInboxDatabase } from '../../src/inbox/threads/store.js';
import { createNoticePreferencesStore } from '../../src/inbox/preferences/store.js';
import { createNoticeMailStore } from '../../src/inbox/mail/store.js';
import { createConnectionStore } from '../../src/connections/store.js';
import type { NoticeMailToSeal } from '../../src/inbox/mail/contract.js';
const resources: { close(): Promise<void> }[] = [];
export const own = <T extends { close(): Promise<void> }>(resource: T): T => {
  resources.push(resource);
  return resource;
};
afterAll(async () => {
  const results = await Promise.allSettled(resources.map((r) => r.close()));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});
export const config = () =>
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 });
export const maintenance = () =>
  parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 });
export const preferences = (available = true) =>
  own(createNoticePreferencesStore(config(), { emailAvailable: available }));
export const inbox = () => own(createWorkspaceInboxDatabase(config()));
export const observer = () =>
  own(createWorkspaceInboxFoldStore(config(), undefined, maintenance()));
export function mail(captured: NoticeMailToSeal[] = []) {
  return own(
    createNoticeMailStore(config(), maintenance(), (input) => {
      captured.push(input);
      return {
        ciphertext: 'sealed-test-content',
        nonce: 'nonce',
        tag: 'tag',
        keyVersion: 'mail-v1',
      };
    }),
  );
}
export async function seedNoticeWorkspace() {
  const owner = (
    await identity.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Notice owner',
    })
  ).id;
  const workspaceId = (
    await identity.createWorkspaceWithOwner({
      name: 'Notice proof',
      slug: `notice-${randomUUID().slice(0, 12)}`,
      ownerUserId: owner,
    })
  ).id;
  const members = {
    owner,
    admin: randomUUID(),
    operator: randomUUID(),
    builder: randomUUID(),
    viewer: randomUUID(),
  };
  for (const role of ['admin', 'operator', 'builder', 'viewer'] as const) {
    const id = members[role];
    await identity.createUser({
      id,
      email: `${id}@example.test`,
      displayName: role,
    });
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
      [workspaceId, id, role],
      workspaceId,
    );
  }
  await queryAsOwner(
    'update app.users set email_verified=true where id=any($1::uuid[])',
    [Object.values(members)],
  );
  const workflowId = await seedNoticeWorkflow(workspaceId, owner);
  return {
    workspaceId,
    workflowId,
    members,
    scope: { workspaceId, actorId: owner },
  };
}
export async function seedNoticeWorkflow(workspaceId: string, owner: string) {
  const workflowId = randomUUID();
  await queryAsOwner(
    'insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)',
    [workflowId, workspaceId, `Workflow ${workflowId.slice(0, 8)}`, owner],
    workspaceId,
  );
  return workflowId;
}
async function execution(
  workspaceId: string,
  statement: string,
  parameters: readonly unknown[],
) {
  return withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query(statement, [...parameters]),
  );
}
export async function seedFailure(workspaceId: string, workflowId: string) {
  const runId = randomUUID();
  await execution(
    workspaceId,
    "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','failed')",
    [runId, workspaceId, workflowId, randomUUID()],
  );
  await queryAsOwner(
    "insert into app.workspace_inbox_events(id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at) values($1,$2,$3,$4,1,'failed',clock_timestamp())",
    [randomUUID(), workspaceId, workflowId, runId],
    workspaceId,
  );
  return runId;
}
export async function seedApproval(
  workspaceId: string,
  workflowId: string,
  {
    starter,
    named,
    allowStarterToDecide,
  }: Readonly<{
    starter: string;
    named?: string | undefined;
    allowStarterToDecide?: boolean | undefined;
  }>,
) {
  const runId = randomUUID(),
    versionId = randomUUID(),
    nodeId = randomUUID(),
    taskId = randomUUID();
  const invocation = `${versionId}|approval|b:|i:`;
  await execution(
    workspaceId,
    "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,started_by,deadline_at) values($1,$2,$3,$4,'manual','waiting',$5,null)",
    [runId, workspaceId, workflowId, versionId, starter],
  );
  await execution(
    workspaceId,
    "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,control_kind,resume_at) values($1,$2,$3,'approval',$4,'{}','waiting','safe','human_task',clock_timestamp()+interval '7 days')",
    [nodeId, workspaceId, runId, invocation],
  );
  const cfg = approvalConfigSchema.parse({
    ...(named === undefined
      ? {}
      : { audience: { roles: [], memberIds: [named] } }),
    ...(allowStarterToDecide === undefined ? {} : { allowStarterToDecide }),
  });
  await execution(
    workspaceId,
    "insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,expires_at) values($1,$2,$3,$4,$5,$6,'approval',$7::jsonb,clock_timestamp()+interval '7 days')",
    [
      taskId,
      workspaceId,
      runId,
      versionId,
      nodeId,
      invocation,
      JSON.stringify(cfg),
    ],
  );
  return { runId, taskId };
}
export async function unhealthyConnection(workspaceId: string, owner: string) {
  const connectionId = randomUUID(),
    secretVersionId = randomUUID();
  const connections = own(createConnectionStore(config()));
  await connections.createConnection({
    workspaceId,
    actorId: owner,
    connectionId,
    secretVersionId,
    providerKey: 'http',
    name: 'Sample provider',
    authType: 'http_headers',
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64),
    sealed: {
      kmsKeyReference: 'self-managed:v1',
      encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
      ciphertext: 'ZW5jcnlwdGVk',
      nonce: Buffer.alloc(12, 1).toString('base64url'),
      tag: Buffer.alloc(16, 1).toString('base64url'),
    },
  });
  const claim = {
    workspaceId,
    actorId: owner,
    connectionId,
    expectedProviderKey: 'http',
    idempotencyKey: randomUUID(),
    requestHash: 'b'.repeat(64),
    dispatchToken: randomUUID(),
  };
  await connections.startConnectionTest(claim);
  await connections.resolveConnectionTestSecret(claim);
  await connections.markConnectionTestDispatched({ ...claim, secretVersionId });
  await connections.completeConnectionTest({
    ...claim,
    secretVersionId,
    outcome: {
      ok: false,
      httpStatus: 401,
      errorCode: 'connection.http_unauthorized',
      reauthorizationRequired: true,
    },
  });
  return connectionId;
}
export { queryAsOwner };
