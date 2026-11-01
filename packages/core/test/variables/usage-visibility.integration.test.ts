import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { CONNECTION_AUTH_TYPE } from '../../src/connections/contract.js';
import { createConnectionDatabase } from '../../src/connections/store.js';
import {
  actorId,
  apiUrl,
  draftNode,
  emptyGraph,
  identity,
  queryAsOwner,
  workflowId,
  workspaceId,
} from '../support/workflow-authoring.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  builder,
  folderId,
  folders,
  publicId,
} from '../tenant-access/resources/folders/fixture.js';
import { createWorkspaceVariablesStore } from '../../src/variables/index.js';
beforeAll(beforeAllFixture1, 30_000);
afterAll(afterAllFixture2);
it('omits hidden workflow identities from variable and connection usage before pagination', async () => {
  for (const id of [workflowId, publicId]) {
    const graph = {
      ...emptyGraph,
      nodes: [
        {
          ...draftNode('variable'),
          inputMappings: {
            amount: { kind: 'workspace_variable', name: 'CURRENCY' },
          },
        },
      ],
    };
    await queryAsOwner(
      'update app.workflow_drafts set graph_json=$3::json where workspace_id=$1 and workflow_id=$2',
      [workspaceId, id, JSON.stringify(graph)],
      workspaceId,
    );
  }
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 2 });
  const variables = createWorkspaceVariablesStore(config);
  const connections = createConnectionDatabase(config);
  const connectionId = randomUUID();
  try {
    const usage = await variables.usage({
      workspaceId,
      actorId: builder,
      name: 'CURRENCY',
      limit: 1,
    });
    expect(usage.items.map(({ workflowId }) => workflowId)).toEqual([publicId]);
    expect(usage.next).toBeNull();
    await connections.createConnection({
      workspaceId,
      actorId,
      connectionId,
      secretVersionId: randomUUID(),
      providerKey: 'http',
      authType: CONNECTION_AUTH_TYPE.httpHeaders,
      name: 'Shared connection',
      idempotencyKey: randomUUID(),
      requestHash: 'c'.repeat(64),
      sealed: {
        kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/example',
        encryptedDataKey: Buffer.alloc(96, 1).toString('base64url'),
        ciphertext: Buffer.from('encrypted-fixture').toString('base64url'),
        nonce: Buffer.alloc(12, 1).toString('base64url'),
        tag: Buffer.alloc(16, 1).toString('base64url'),
      },
    });
    await queryAsOwner(
      `insert into app.workflow_integration_usage(workspace_id,workflow_version_id,provider_key,operation_key,connection_id)
    select workspace_id,id,'http','request',$2 from app.workflow_versions where workspace_id=$1 and workflow_id=any($3::uuid[])`,
      [workspaceId, connectionId, [workflowId, publicId]],
      workspaceId,
    );
    const page = await connections.listConnectionUsage({
      workspaceId,
      actorId: builder,
      connectionId,
      limit: 1,
    });
    expect(page.items.map(({ workflowId }) => workflowId)).toEqual([publicId]);
    expect(page.nextCursor).toBeUndefined();
  } finally {
    await variables.close();
    await connections.close();
  }
});

// Sorted after every generated id, so the check would otherwise promise more.
const LAST_HIDDEN = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

it('does not promise more pages because a hidden workflow sorts after the last visible one', async () => {
  await queryAsOwner(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Hidden last',$3)",
    [LAST_HIDDEN, workspaceId, actorId],
    workspaceId,
  );
  await folders.placeWorkflow({
    workspaceId,
    actorId,
    workflowId: LAST_HIDDEN,
    folderId,
    expectedOrganizationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 2 });
  const variables = createWorkspaceVariablesStore(config);
  try {
    const page = await variables.usage({
      workspaceId,
      actorId: builder,
      name: 'CURRENCY',
      limit: 25,
    });
    expect(page.items.map((item) => item.workflowId)).toEqual([publicId]);
    expect(page.next).toBeNull();
    expect(page).toMatchObject({ checkedWorkflows: 1, totalWorkflows: 1 });
    let after: typeof page.next = null;
    const seenByOwner: string[] = [];
    for (let visited = 0; visited < 8; visited += 1) {
      const next: typeof page = await variables.usage({
        workspaceId,
        actorId,
        name: 'CURRENCY',
        limit: 25,
        ...(after === null ? {} : { after }),
      });
      seenByOwner.push(...next.items.map((item) => item.workflowId));
      after = next.next;
      if (after === null) break;
    }
    expect(after).toBeNull();
    expect(seenByOwner).toContain(publicId);
  } finally {
    await variables.close();
  }
});

describe.each(['suspended', 'pending_deletion'])(
  'in a workspace that is %s',
  (status) => {
    const usageOf = async (
      variables: ReturnType<typeof createWorkspaceVariablesStore>,
      actor: string,
    ) => {
      const items: string[] = [];
      let last = await variables.usage({
        workspaceId,
        actorId: actor,
        name: 'CURRENCY',
        limit: 25,
      });
      items.push(...last.items.map((item) => item.workflowId));
      while (last.next !== null) {
        last = await variables.usage({
          workspaceId,
          actorId: actor,
          name: 'CURRENCY',
          limit: 25,
          after: last.next,
        });
        items.push(...last.items.map((item) => item.workflowId));
      }
      return { items, last };
    };

    it('shows a folder-limited member only what they can see, and an admin everything', async () => {
      const graph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('variable'),
            inputMappings: {
              amount: { kind: 'workspace_variable', name: 'CURRENCY' },
            },
          },
        ],
      };
      for (const id of [workflowId, publicId])
        await queryAsOwner(
          'update app.workflow_drafts set graph_json=$3::json where workspace_id=$1 and workflow_id=$2',
          [workspaceId, id, JSON.stringify(graph)],
          workspaceId,
        );
      const manager = randomUUID();
      await identity.createUser({
        id: manager,
        email: `${manager}@example.test`,
        displayName: 'Workspace admin',
      });
      await queryAsOwner(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
        [workspaceId, manager],
        workspaceId,
      );
      const [everything] = await queryAsOwner<{ total: number }>(
        'select count(*)::int total from app.workflows where workspace_id=$1',
        [workspaceId],
        workspaceId,
      );
      await queryAsOwner(
        status === 'suspended'
          ? "update app.workspaces set status='suspended' where id=$1"
          : `update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp(),
             deletion_requested_by=created_by,deletion_reason='Variables test',
             purge_after=clock_timestamp()+interval '30 days' where id=$1`,
        [workspaceId],
        workspaceId,
      );
      const variables = createWorkspaceVariablesStore(
        parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      );
      try {
        const limited = await usageOf(variables, builder);
        expect(limited.items).toEqual([publicId]);
        expect(limited.last).toMatchObject({
          checkedWorkflows: 1,
          totalWorkflows: 1,
          next: null,
        });
        for (const actor of [actorId, manager]) {
          const all = await usageOf(variables, actor);
          expect([...all.items].sort()).toEqual([workflowId, publicId].sort());
          expect(all.last).toMatchObject({
            checkedWorkflows: everything?.total,
            totalWorkflows: everything?.total,
          });
        }
      } finally {
        await variables.close();
        await queryAsOwner(
          `update app.workspaces set status='active',deletion_requested_at=null,
             deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
          [workspaceId],
          workspaceId,
        );
      }
    });
  },
);
