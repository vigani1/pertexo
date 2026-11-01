import {
  actorId,
  workspaceA,
  workspaceB,
  workflowA,
  workflowB,
  versionA,
  versionB,
  notificationConnectionId,
  notificationSecretVersionId,
  notificationDestinationId,
} from './context.js';
import { asOwner } from './queries.js';

export async function seedIdentityAndExecutables(): Promise<void> {
  await asOwner(workspaceA, async (client) => {
    await client.query('alter table app.workflows no force row level security');
    await client.query(
      'alter table app.workflow_versions no force row level security',
    );
    for (const table of [
      'connections',
      'connection_secret_versions',
      'failure_notification_destinations',
      'failure_notification_destination_versions',
    ])
      await client.query(
        `alter table app.${table} no force row level security`,
      );
    await client.query(
      `insert into app.users (id,email,display_name) values ($1,$2,'Run Store')`,
      [actorId, `run-store-${actorId}@example.test`],
    );
    for (const [workspaceId, workflowId, versionId, suffix] of [
      [workspaceA, workflowA, versionA, 'a'],
      [workspaceB, workflowB, versionB, 'b'],
    ] as const) {
      await client.query(
        `insert into app.workspaces (id,name,slug,created_by)
         values ($1,$2,$3,$4)`,
        [
          workspaceId,
          `Workspace ${suffix}`,
          `run-store-${suffix}-${workspaceId.slice(0, 8)}`,
          actorId,
        ],
      );
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         values ($1,$2,'owner','active')`,
        [workspaceId, actorId],
      );
      await client.query(
        `insert into app.workspace_execution_entitlement_versions (
           workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
         ) values ($1,2,'active',10000,100000,'-infinity'::timestamptz)`,
        [workspaceId],
      );
      await client.query(
        `update app.workspace_execution_entitlements set current_version=2
          where workspace_id=$1`,
        [workspaceId],
      );
      await client.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,$3,$4)`,
        [workflowId, workspaceId, `Workflow ${suffix}`, actorId],
      );
      await client.query(
        `insert into app.workflow_versions (
           id,workspace_id,workflow_id,version_number,graph_json,
           checksum,executable_json,published_by
         ) values ($1,$2,$3,1,'{}'::jsonb,$4,$5::jsonb,$6)`,
        [
          versionId,
          workspaceId,
          workflowId,
          `wf:sha256:${suffix.repeat(64)}`,
          JSON.stringify({
            graph: {
              nodes: [
                {
                  id: 'parallel',
                  definition: { key: 'core.parallel', version: 1 },
                },
                { id: 'loop', definition: { key: 'core.foreach', version: 1 } },
                {
                  id: 'condition',
                  definition: { key: 'core.condition', version: 1 },
                },
                {
                  id: 'switch',
                  definition: { key: 'core.switch', version: 1 },
                },
              ],
              edges: [],
            },
          }),
          actorId,
        ],
      );
    }
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    await client.query(
      `insert into app.connections (
         id,workspace_id,provider_key,name,auth_type,status,
         current_secret_version_id,created_by
       ) values ($1,$2,'email','Run failure email','resend_api_key','active',$3,$4)`,
      [
        notificationConnectionId,
        workspaceA,
        notificationSecretVersionId,
        actorId,
      ],
    );
    await client.query(
      `insert into app.connection_secret_versions (
         id,workspace_id,connection_id,kms_key_reference,
         encrypted_data_key,ciphertext,nonce,auth_tag,created_by
       ) values ($1,$2,$3,'kms','key','cipher','AAAAAAAAAAAAAAAA',
         'AAAAAAAAAAAAAAAAAAAAAA',$4)`,
      [
        notificationSecretVersionId,
        workspaceA,
        notificationConnectionId,
        actorId,
      ],
    );
    await client.query(
      `insert into app.failure_notification_destinations
         (id,workspace_id,kind,status,current_config_version,created_by)
       values ($1,$2,'email','enabled',1,$3)`,
      [notificationDestinationId, workspaceA, actorId],
    );
    await client.query(
      `insert into app.failure_notification_destination_versions
         (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
       values ($1,$2,1,'email','idempotent_with_key',$3::jsonb,$4)`,
      [
        workspaceA,
        notificationDestinationId,
        JSON.stringify({
          connectionId: notificationConnectionId,
          toEmail: 'run-store@example.test',
        }),
        actorId,
      ],
    );
    await client.query('alter table app.workflows force row level security');
    await client.query(
      'alter table app.workflow_versions force row level security',
    );
    await client.query('set constraints all immediate');
    for (const table of [
      'connections',
      'connection_secret_versions',
      'failure_notification_destinations',
      'failure_notification_destination_versions',
    ])
      await client.query(`alter table app.${table} force row level security`);
  });
}
