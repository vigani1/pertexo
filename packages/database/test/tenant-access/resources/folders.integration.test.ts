import { connectionScope } from '../../../src/tenant-access/resources/connections/scope.js';
import { inspectPromotionCallDependencies } from '../../../src/authoring/promotion/preparation/calls.js';
import { PromotionGraphBudget } from '../../../src/authoring/promotion/preparation/graph.js';
import { readFolderScope } from '../../../src/tenant-access/resources/facts.js';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { requireWorkflowCallTargets } from '../../../src/tenant-access/resources/bindings.js';
import { createWorkspaceVariablesStore } from '../../../src/variables/store.js';
import {
  createConnectionDatabase,
  CONNECTION_AUTH_TYPE,
} from '../../../src/connections/database.js';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import { createArtifactUploadDatabase } from '../../../src/artifacts/upload.js';
import { ArtifactMetadataNotFoundError } from '../../../src/artifacts/store.js';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  apiPool,
  authoring,
  emptyGraph,
  draftNode,
  identity,
  queryAsOwner,
  workspaceId,
  workflowId,
} from '../../support/workflow-authoring.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { createWorkflowFolderDatabase } from '../../../src/authoring/organization/folders/commands.repository.js';
import { createWorkflowOrganizationReadDatabase } from '../../../src/authoring/organization/workflows.queries.js';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';

const builder = randomUUID(),
  viewer = randomUUID();
let folderId = '',
  publicId = '',
  privateRun = '',
  publicRun = '';
let folders: ReturnType<typeof createWorkflowFolderDatabase>;
let organization: ReturnType<typeof createWorkflowOrganizationReadDatabase>;
let runs: ReturnType<typeof createWorkflowRunDatabase>;
beforeAll(beforeAllFixture1, 30_000);
afterAll(afterAllFixture2);
registerOmitsInaccessibleWorkflowsRetainedRun();

registerFencesGrantEditsAudienceReviews();

registerChecksRetainedFileOwnersBefore();

registerOmitsHiddenWorkflowIdentitiesVariable();

registerKeepsRetainedRunReadsAvailable();

async function beforeAllFixture1() {
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 3 });
  folders = createWorkflowFolderDatabase(config);
  organization = createWorkflowOrganizationReadDatabase(config);
  runs = createWorkflowRunDatabase(config);
  for (const id of [builder, viewer])
    await identity.createUser({
      id,
      email: `${id}@example.test`,
      displayName: 'Resource reader',
    });
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active'),($1,$3,'viewer','active')",
    [workspaceId, builder, viewer],
    workspaceId,
  );
  folderId = (
    await folders.createFolder({
      workspaceId,
      actorId,
      name: 'Private',
      parentId: null,
      idempotencyKey: randomUUID(),
    })
  ).folder.id;
  await folders.placeWorkflow({
    workspaceId,
    actorId,
    workflowId,
    folderId,
    expectedOrganizationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await queryAsOwner(
    "update app.workflow_folders set access_mode='restricted' where workspace_id=$1 and id=$2",
    [workspaceId, folderId],
    workspaceId,
  );
  publicId = (
    await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Public',
      emptyGraph,
      idempotencyKey: randomUUID(),
    })
  ).workflowId;
  for (const [id, isPrivate] of [
    [workflowId, true],
    [publicId, false],
  ] as const) {
    const version = randomUUID(),
      run = randomUUID();
    await queryAsOwner(
      "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::json,'{}','wf:sha256:'||repeat('a',64),$5)",
      [version, workspaceId, id, JSON.stringify(emptyGraph), actorId],
      workspaceId,
    );
    await withTenantScopedClient(apiPool, { workspaceId }, (client) =>
      client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,started_at,completed_at,input_ref,input_ref_expires_at)
       values($1,$2,$3,$4,'manual',$5,clock_timestamp()-interval '10 seconds',clock_timestamp()-interval '9 seconds',clock_timestamp()-interval '1 second','{"kind":"inline","value":{"private":true}}',clock_timestamp()+interval '29 days')`,
        [run, workspaceId, id, version, isPrivate ? 'failed' : 'succeeded'],
      ),
    );
    if (isPrivate) privateRun = run;
    else publicRun = run;
  }
}

async function afterAllFixture2() {
  await Promise.all([folders.close(), organization.close(), runs.close()]);
}

function registerOmitsInaccessibleWorkflowsRetainedRun(): void {
  it('omits inaccessible workflows and retained run data, before pagination and counts', async () => {
    expect(
      await authoring.getWorkflow(workspaceId, workflowId, builder),
    ).toBeNull();
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).toBeNull();
    expect(
      (
        await authoring.listWorkflows({
          workspaceId,
          actorId: builder,
          limit: 1,
        })
      ).items.map(({ id }) => id),
    ).toEqual([publicId]);
    expect(
      (
        await organization.listWorkflows({
          workspaceId,
          actorId: builder,
          limit: 1,
        })
      ).items.map(({ workflow }) => workflow.id),
    ).toEqual([publicId]);
    expect(
      (await folders.listFolders({ workspaceId, actorId: builder })).items,
    ).toEqual([]);
    expect(
      await runs.get({ workspaceId, actorId: builder, runId: privateRun }),
    ).toBeUndefined();
    expect(
      await runs.readInput({
        workspaceId,
        actorId: builder,
        runId: privateRun,
      }),
    ).toBeUndefined();
    expect(
      await runs.canRead({ workspaceId, actorId: builder, runId: privateRun }),
    ).toBe(false);
    const page = await runs.list({ workspaceId, actorId: builder, limit: 1 });
    expect(page.items.map(({ id }) => id)).toEqual([publicRun]);
    expect(page.nextCursor).toBeUndefined();
    const statistics = await runs.statistics({
      workspaceId,
      actorId: builder,
      window: '24h',
      includeWorkflows: true,
    });
    expect(statistics.window.total).toBe(1);
    expect(statistics.window.byStatus.failed).toBe(0);
    expect(
      statistics.workflows?.items.map(({ workflowId }) => workflowId),
    ).toEqual([publicId]);
    const trends = await runs.usageTrends({
      workspaceId,
      actorId: builder,
      period: '30d',
      includeWorkflowNames: true,
    });
    expect(trends.total).toBe(1);
    expect(trends.busiest.map(({ workflowId }) => workflowId)).toEqual([
      publicId,
    ]);
  });

  it('allows a Viewer grant to read without granting authoring, and keeps the workspace ceiling', async () => {
    for (const user of [builder, viewer])
      await queryAsOwner(
        "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
        [randomUUID(), workspaceId, folderId, user],
        workspaceId,
      );
    try {
      expect(
        await authoring.getDraft(workspaceId, workflowId, builder),
      ).not.toBeNull();
      expect(
        (await authoring.getWorkflow(workspaceId, workflowId, builder))
          ?.resourceAccess,
      ).toEqual({ canEdit: false, canPublish: false });
      expect(
        (
          await organization.getWorkflow({
            workspaceId,
            workflowId,
            actorId: builder,
          })
        )?.workflow.resourceAccess,
      ).toEqual({ canEdit: false, canPublish: false });
      expect(
        (
          await folders.listFolders({ workspaceId, actorId: builder })
        ).items.find((folder) => folder.id === folderId)?.canCreateWorkflows,
      ).toBe(false);
      expect(
        await runs.canRead({ workspaceId, actorId: viewer, runId: privateRun }),
      ).toBe(true);
      await expect(
        authoring.renameWorkflow({
          workspaceId,
          actorId: builder,
          workflowId,
          name: 'Denied',
          expectedNameRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    } finally {
      await queryAsOwner(
        'delete from app.workflow_folder_grants where workspace_id=$1',
        [workspaceId],
        workspaceId,
      );
    }
  });
}

function registerFencesGrantEditsAudienceReviews(): void {
  it('fences grant edits, audience reviews and replayed authoring commands with current authority', async () => {
    const privateFolder = (
      await folders.createFolder({
        workspaceId,
        actorId,
        name: 'Reviewed audience',
        parentId: null,
        idempotencyKey: randomUUID(),
      })
    ).folder;
    const created = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Scoped creation',
      emptyGraph,
      folderId: privateFolder.id,
      idempotencyKey: randomUUID(),
    });
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId: privateFolder.id,
      idempotencyKey: randomUUID(),
      request: {
        mode: 'restricted',
        expectedFolderRevision: 1,
        grants: [{ kind: 'member', userId: builder, access: 'editor' }],
      },
    });
    expect(
      (await authoring.getWorkflow(workspaceId, created.workflowId, builder))
        ?.resourceAccess,
    ).toEqual({ canEdit: true, canPublish: true });
    expect(
      (
        await folders.readSharing({
          workspaceId,
          folderId: privateFolder.id,
          actorId,
        })
      ).labels?.[builder],
    ).toBe('Resource reader');
    expect(
      await authoring.getDraft(workspaceId, created.workflowId, viewer),
    ).toBeNull();
    expect(
      await authoring.getDraft(workspaceId, created.workflowId, builder),
    ).not.toBeNull();
    await expect(
      folders.replaceSharing({
        workspaceId,
        actorId: builder,
        folderId: privateFolder.id,
        idempotencyKey: randomUUID(),
        request: { mode: 'workspace', expectedFolderRevision: 2, grants: [] },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    const move = {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      folderId: null,
      expectedOrganizationRevision: 1,
    };
    await expect(
      folders.placeWorkflow({
        ...move,
        actorId: builder,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: 'audience_review' });
    const request = {
      kind: 'workflows' as const,
      workflowIds: [created.workflowId],
      destinationFolderId: null,
    };
    const reviewed = (
      await folders.reviewMove({ workspaceId, actorId, request })
    ).items[0];
    if (reviewed === undefined) throw new Error('Audience review missing');
    expect(reviewed.requiresReview).toBe(true);
    expect(reviewed.removedRestrictions.map(({ id }) => id)).toEqual([
      privateFolder.id,
    ]);
    await folders.renameFolder({
      workspaceId,
      actorId,
      folderId: privateFolder.id,
      expectedFolderRevision: 2,
      name: 'Changed audience',
      idempotencyKey: randomUUID(),
    });
    await expect(
      folders.placeWorkflow({
        ...move,
        audienceReview: { token: reviewed.token, acknowledge: true },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: 'audience_review' });
    const current = (
      await folders.reviewMove({ workspaceId, actorId, request })
    ).items[0];
    if (current === undefined) throw new Error('Audience review missing');
    await folders.placeWorkflow({
      ...move,
      audienceReview: { token: current.token, acknowledge: true },
      idempotencyKey: randomUUID(),
    });
    await folders.placeWorkflow({
      workspaceId,
      actorId: builder,
      workflowId: created.workflowId,
      folderId: privateFolder.id,
      expectedOrganizationRevision: 2,
      idempotencyKey: randomUUID(),
    });
    const rename = {
      workspaceId,
      actorId: builder,
      workflowId: created.workflowId,
      name: 'Renamed while allowed',
      expectedNameRevision: 1,
      idempotencyKey: randomUUID(),
    };
    await authoring.renameWorkflow(rename);
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId: privateFolder.id,
      idempotencyKey: randomUUID(),
      request: { mode: 'restricted', expectedFolderRevision: 3, grants: [] },
    });
    await expect(authoring.renameWorkflow(rename)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    const audit = await queryAsOwner<{ metadata: Record<string, unknown> }>(
      "select metadata from app.audit_events where workspace_id=$1 and action='workflow.folder_sharing_changed' and target_id=$2 order by id",
      [workspaceId, privateFolder.id],
      workspaceId,
    );
    expect(audit).toHaveLength(2);
  });
}

function registerChecksRetainedFileOwnersBefore(): void {
  it('checks retained file owners before saving references and allows deliberate sharing through a readable workflow', async () => {
    const artifactId = randomUUID();
    const descriptor = {
      kind: 'artifact' as const,
      artifactId,
      byteLength: 4,
      mediaType: 'application/octet-stream',
      sha256: 'b'.repeat(64),
    };
    await queryAsOwner(
      `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at)
    values($1,$2,'http-response',$3,$4,4,$5,'available',clock_timestamp()+interval '29 days',clock_timestamp())`,
      [
        artifactId,
        workspaceId,
        `workspaces/${workspaceId}/artifacts/${artifactId}`,
        descriptor.mediaType,
        descriptor.sha256,
      ],
      workspaceId,
    );
    await queryAsOwner(
      `update app.workflow_runs set output_ref=$3 where workspace_id=$1 and id=$2`,
      [
        workspaceId,
        privateRun,
        JSON.stringify({ kind: 'inline', value: descriptor }),
      ],
      workspaceId,
    );
    const files = createArtifactUploadDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const metadata = (reader: string) =>
      files.getMetadata({
        actor: { workspaceId, actorId: reader },
        identity: { workspaceId, artifactId },
      });
    try {
      expect(await metadata(builder)).toBeNull();
      expect((await metadata(actorId))?.id).toBe(artifactId);
      await queryAsOwner(
        `update app.workflow_runs set input_ref_expires_at=clock_timestamp()-interval '2 days',created_at=clock_timestamp()-interval '32 days',started_at=clock_timestamp()-interval '31 days 1 minute',completed_at=clock_timestamp()-interval '31 days' where workspace_id=$1 and id=$2`,
        [workspaceId, privateRun],
        workspaceId,
      );
      expect(await metadata(actorId)).toBeNull();
      await queryAsOwner(
        `update app.workflow_runs set input_ref_expires_at=clock_timestamp()+interval '29 days',created_at=clock_timestamp()-interval '10 seconds',started_at=clock_timestamp()-interval '9 seconds',completed_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2`,
        [workspaceId, privateRun],
        workspaceId,
      );

      const draft = await authoring.getDraft(workspaceId, publicId, builder);
      if (draft === null) throw new Error('Public draft missing');
      const request = {
        workspaceId,
        workflowId: publicId,
        graphJson: {
          ...emptyGraph,
          nodes: [draftNode('file', { file: descriptor })],
        },
        expectedRevision: draft.revision,
        representationTag: workflowDraftRepresentationTag({
          workflowId: publicId,
          revision: draft.revision,
          graph: draft.graphJson,
          compatibilityFingerprint: draft.compatibility.fingerprint,
        }),
      };
      await expect(
        authoring.saveDraft({ ...request, actorId: builder }),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      expect(
        (await authoring.getDraft(workspaceId, publicId, actorId))?.revision,
      ).toBe(draft.revision);
      await authoring.saveDraft({ ...request, actorId });
      expect((await metadata(builder))?.id).toBe(artifactId);
      expect(
        await runs.canRead({
          workspaceId,
          actorId: builder,
          runId: privateRun,
        }),
      ).toBe(false);
    } finally {
      await files.close();
    }
  });

  it('uses only current linked directory groups and never revives grants after unlinking', async () => {
    const organizationId = randomUUID(),
      groupId = randomUUID(),
      directoryUserId = randomUUID();
    await queryAsOwner(
      "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Resource groups')",
      [organizationId, workspaceId],
      workspaceId,
    );
    await queryAsOwner(
      'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$2)',
      [workspaceId, organizationId],
      workspaceId,
    );
    await queryAsOwner(
      "insert into app.auth_directory_groups(id,organization_id,display_name) values($1,$2,'Builders')",
      [groupId, organizationId],
      workspaceId,
    );
    await queryAsOwner(
      "insert into app.auth_directory_users(id,organization_id,user_name,normalized_user_name,login_email,profile,user_id) values($1,$2,$3,$3,$3,'{}',$4)",
      [directoryUserId, organizationId, `${builder}@example.test`, builder],
      workspaceId,
    );
    await queryAsOwner(
      'insert into app.auth_directory_group_members(organization_id,group_id,directory_user_id) values($1,$2,$3)',
      [organizationId, groupId, directoryUserId],
      workspaceId,
    );
    const sharing = await folders.readSharing({
      workspaceId,
      actorId,
      folderId,
    });
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId,
      idempotencyKey: randomUUID(),
      request: {
        mode: 'restricted',
        expectedFolderRevision: sharing.revision,
        grants: [{ kind: 'group', organizationId, groupId, access: 'editor' }],
      },
    });
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).not.toBeNull();
    await queryAsOwner(
      'update app.auth_directory_users set active=false where id=$1',
      [directoryUserId],
      workspaceId,
    );
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).toBeNull();
    await queryAsOwner(
      'update app.auth_directory_users set active=true where id=$1',
      [directoryUserId],
      workspaceId,
    );
    await queryAsOwner(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [workspaceId, builder],
      workspaceId,
    );
    await expect(
      authoring.getDraft(workspaceId, workflowId, builder),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await queryAsOwner(
      "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
      [workspaceId, builder],
      workspaceId,
    );
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).not.toBeNull();
    await queryAsOwner(
      'delete from app.auth_organization_workspaces where workspace_id=$1',
      [workspaceId],
      workspaceId,
    );
    await queryAsOwner(
      'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$2)',
      [workspaceId, organizationId],
      workspaceId,
    );
    expect(
      (await folders.readSharing({ workspaceId, actorId, folderId })).grants,
    ).toEqual([]);
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).toBeNull();
  });
}

function registerOmitsHiddenWorkflowIdentitiesVariable(): void {
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
      expect(usage.items.map(({ workflowId }) => workflowId)).toEqual([
        publicId,
      ]);
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
      expect(page.items.map(({ workflowId }) => workflowId)).toEqual([
        publicId,
      ]);
      expect(page.nextCursor).toBeUndefined();
    } finally {
      await variables.close();
      await connections.close();
    }
  });

  it('requires target read access for a new Call site even when another site already pins that target', async () => {
    const target = {
      workflowId,
      workflowVersionId: randomUUID(),
      executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
    };
    const call = (id: string) => ({
      ...draftNode(id),
      definition: { key: 'core.call', version: 1 },
      config: { target },
    });
    const previous = { ...emptyGraph, nodes: [call('existing')] };
    const added = {
      ...emptyGraph,
      nodes: [call('existing'), call('new-site')],
    };
    const admit = (reader: string, graph = added) =>
      withTenantScopedClient(
        apiPool,
        { workspaceId, actorId: reader },
        (client) =>
          requireWorkflowCallTargets(
            client,
            { workspaceId, actorId: reader },
            graph,
            previous,
          ),
      );
    await expect(admit(builder)).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
    await expect(admit(actorId)).resolves.toBeUndefined();
    await expect(admit(builder, previous)).resolves.toBeUndefined();
  });

  it('keeps delegated private child requirements out of promotion reviews', async () => {
    const versionId = randomUUID(),
      checksum = `wf:sha256:${'a'.repeat(64)}`;
    const child = {
      ...emptyGraph,
      nodes: [
        {
          ...draftNode('private-data'),
          inputMappings: {
            value: {
              kind: 'workspace_variable' as const,
              name: 'PRIVATE_CHILD_VARIABLE',
            },
          },
        },
      ],
    };
    await queryAsOwner(
      "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,2,$4::json,'{}',$5,$6)",
      [
        versionId,
        workspaceId,
        workflowId,
        JSON.stringify(child),
        checksum,
        actorId,
      ],
      workspaceId,
    );
    const graph = {
      ...emptyGraph,
      nodes: [
        {
          ...draftNode('delegated'),
          definition: { key: 'core.call', version: 1 },
          config: {
            target: {
              workflowId,
              workflowVersionId: versionId,
              executableChecksum: checksum,
            },
          },
        },
      ],
    };
    const source = {
      workflowId: publicId,
      versionId: randomUUID(),
      versionNumber: 1,
      name: 'Visible parent',
      checksum,
      graph,
    };
    const inspect = (reader: string) =>
      withTenantScopedClient(
        apiPool,
        { workspaceId, actorId: reader },
        async (client) => {
          const requirements: WorkflowPromotionRequirement[] = [];
          const resources = await readFolderScope(client, {
            workspaceId,
            actorId: reader,
          });
          await inspectPromotionCallDependencies(client, workspaceId, {
            source,
            targetWorkflowId: publicId,
            resources,
            connections: connectionScope(
              { workspaceId, actorId: reader },
              resources.role,
              'connection:use',
            ),
            graph,
            budget: new PromotionGraphBudget(),
            report: (item) => requirements.push(item),
          });
          return requirements;
        },
      );
    expect(await inspect(actorId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'PRIVATE_CHILD_VARIABLE' }),
      ]),
    );
    expect(await inspect(builder)).toEqual([]);
  });
}

function registerKeepsRetainedRunReadsAvailable(): void {
  it('keeps retained run reads available in inactive workspaces without widening folder grants or writes', async () => {
    try {
      for (const status of ['suspended', 'pending_deletion']) {
        await queryAsOwner(
          `update app.workspaces set status=$2::text,
          deletion_requested_at=case when $2::text='pending_deletion' then clock_timestamp() end,
          deletion_requested_by=case when $2::text='pending_deletion' then $3::uuid end,
          deletion_reason=case when $2::text='pending_deletion' then 'retained-read proof' end,
          purge_after=case when $2::text='pending_deletion' then clock_timestamp()+interval '1 day' end
          where id=$1`,
          [workspaceId, status, actorId],
          workspaceId,
        );
        expect(
          await runs.canRead({ workspaceId, actorId, runId: privateRun }),
        ).toBe(true);
        expect(
          await runs.canRead({
            workspaceId,
            actorId: builder,
            runId: privateRun,
          }),
        ).toBe(false);
        expect(
          await runs.canRead({
            workspaceId,
            actorId: builder,
            runId: publicRun,
          }),
        ).toBe(true);
        await expect(
          authoring.createWorkflow({
            workspaceId,
            actorId: builder,
            name: 'Inactive write',
            emptyGraph,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toThrow();
      }
    } finally {
      await queryAsOwner(
        "update app.workspaces set status='active',deletion_requested_at=null,deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1",
        [workspaceId],
        workspaceId,
      );
    }
  });

  it('serializes a grant removal against authoring and refuses even an exact old command after revocation', async () => {
    const folder = (
      await folders.createFolder({
        workspaceId,
        actorId,
        name: 'Concurrent sharing',
        parentId: null,
        idempotencyKey: randomUUID(),
      })
    ).folder;
    const created = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Concurrent authoring',
      emptyGraph,
      folderId: folder.id,
      idempotencyKey: randomUUID(),
    });
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId: folder.id,
      idempotencyKey: randomUUID(),
      request: {
        mode: 'restricted',
        expectedFolderRevision: 1,
        grants: [{ kind: 'member', userId: builder, access: 'editor' }],
      },
    });
    const command = {
      workspaceId,
      actorId: builder,
      workflowId: created.workflowId,
      name: 'Accepted before revocation',
      expectedNameRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const [write, revoke] = await Promise.allSettled([
      authoring.renameWorkflow(command),
      folders.replaceSharing({
        workspaceId,
        actorId,
        folderId: folder.id,
        idempotencyKey: randomUUID(),
        request: { mode: 'restricted', expectedFolderRevision: 2, grants: [] },
      }),
    ]);
    expect(revoke.status).toBe('fulfilled');
    if (write.status === 'rejected')
      expect(write.reason).toBeInstanceOf(WorkflowNotFoundError);
    expect(
      await authoring.getWorkflow(workspaceId, created.workflowId, builder),
    ).toBeNull();
    await expect(authoring.renameWorkflow(command)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    const current = await authoring.getWorkflow(
      workspaceId,
      created.workflowId,
      actorId,
    );
    expect(current?.name).toBe(
      write.status === 'fulfilled' ? command.name : 'Concurrent authoring',
    );
  });
}
