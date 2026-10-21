import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Grants are ordinary workspace rows, restored with their original identities. */
export function seedSharingRecoveryFixture(sql, database) {
  const member = randomUUID(),
    folder = randomUUID();
  const source = JSON.parse(
    sql(
      database,
      `select json_build_object('connection',connection.id,'connectionWorkspace',connection.workspace_id,'creator',connection.created_by,'workflow',workflow.id,'workflowWorkspace',workflow.workspace_id) from app.connections connection cross join app.workflows workflow order by connection.id,workflow.id limit 1;`,
    ).trim(),
  );
  sql(
    database,
    `begin;
    insert into app.users(id,email,display_name) values('${member}','${member}@example.test','Restored sharing member');
    insert into app.workspace_memberships(workspace_id,user_id,role,status) values
      ('${source.connectionWorkspace}','${member}','builder','active'),
      ('${source.workflowWorkspace}','${member}','builder','active');
    insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values('${source.workflowWorkspace}','${folder}','Restored private folder','restored private folder','restricted');
    insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values('${source.workflowWorkspace}','${source.workflow}','${folder}');
    insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values('${randomUUID()}','${source.workflowWorkspace}','${folder}','${member}','viewer');
    update app.connections set access_mode='restricted',sharing_revision=2 where workspace_id='${source.connectionWorkspace}' and id='${source.connection}';
    insert into app.connection_shares(workspace_id,connection_id,user_id) values('${source.connectionWorkspace}','${source.connection}','${member}');
    commit;`,
  );
  return {
    verify(target) {
      const facts = JSON.parse(
        sql(
          target,
          `select json_build_object(
        'folderMode',(select access_mode from app.workflow_folders where workspace_id='${source.workflowWorkspace}' and id='${folder}'),
        'folderGrant',(select access from app.workflow_folder_grants where workspace_id='${source.workflowWorkspace}' and folder_id='${folder}' and user_id='${member}'),
        'workflowFolder',(select folder_id from app.workflow_organization_state where workspace_id='${source.workflowWorkspace}' and workflow_id='${source.workflow}'),
        'connectionMode',(select access_mode from app.connections where workspace_id='${source.connectionWorkspace}' and id='${source.connection}'),
        'sharingRevision',(select sharing_revision from app.connections where workspace_id='${source.connectionWorkspace}' and id='${source.connection}'),
        'connectionShares',(select count(*) from app.connection_shares where workspace_id='${source.connectionWorkspace}' and connection_id='${source.connection}' and user_id='${member}'),
        'forcedFences',(select bool_and(relforcerowsecurity) from pg_class where oid=any(array['app.workflow_folder_grants'::regclass,'app.connection_shares'::regclass])));`,
        ).trim(),
      );
      assert.deepEqual(facts, {
        folderMode: 'restricted',
        folderGrant: 'viewer',
        workflowFolder: folder,
        connectionMode: 'restricted',
        sharingRevision: 2,
        connectionShares: 1,
        forcedFences: true,
      });
      const foreign = sql(
        target,
        `begin; set local role pertexo_app; select set_config('app.workspace_id','${randomUUID()}',true); select (select count(*) from app.workflow_folder_grants)+(select count(*) from app.connection_shares); rollback;`,
      )
        .trim()
        .split('\n');
      assert.equal(foreign.at(-2), '0');
    },
  };
}
