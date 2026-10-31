import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const encoded = (bytes) => randomBytes(bytes).toString('base64url');

/**
 * A connected OAuth2 connection, sealed, with its consent pending. A restored
 * database must keep all of it, behind the same row security.
 */
export function seedOAuth2RecoveryFixture(sql, database) {
  const member = randomUUID(),
    connection = randomUUID(),
    version = randomUUID(),
    token = randomUUID();
  const source = JSON.parse(
    sql(
      database,
      `select json_build_object('workspace',workspace_id,'creator',created_by) from app.connections order by id limit 1;`,
    ).trim(),
  );
  const sealed = (column) =>
    `'alias/fixture','${encoded(48)}','${encoded(32)}','${encoded(12)}','${encoded(16)}'${column}`;
  sql(
    database,
    `begin;
    set constraints all deferred;
    insert into app.users(id,email,display_name) values('${member}','${member}@example.test','Restored OAuth2 starter');
    insert into app.workspace_memberships(workspace_id,user_id,role,status) values('${source.workspace}','${member}','owner','active');
    insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
      values('${connection}','${source.workspace}','http','Restored OAuth2','oauth2','active','${version}','${source.creator}');
    insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
      values('${version}','${source.workspace}','${connection}',${sealed(`,'${source.creator}'`)});
    insert into app.connection_oauth2_clients(workspace_id,connection_id,secret_version_id,settings)
      values('${source.workspace}','${connection}','${version}','{"clientId":"restored"}');
    insert into app.connection_oauth2_tokens(id,workspace_id,connection_id,secret_version_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,authorized_at,issued_at,renewable)
      values('${token}','${source.workspace}','${connection}','${version}',${sealed(',clock_timestamp(),clock_timestamp(),true')});
    insert into app.connection_oauth2_authorizations(workspace_id,connection_id,state_digest,binding_digest,started_by,secret_version_id,expires_at)
      values('${source.workspace}','${connection}',decode('${randomBytes(32).toString('hex')}','hex'),decode('${randomBytes(32).toString('hex')}','hex'),'${member}','${version}',clock_timestamp()+interval '600 seconds');
    commit;`,
  );
  return {
    verify(target) {
      const facts = JSON.parse(
        sql(
          target,
          `select json_build_object(
        'client',(select settings->>'clientId' from app.connection_oauth2_clients where connection_id='${connection}'),
        'token',(select id from app.connection_oauth2_tokens where connection_id='${connection}'),
        'pending',(select count(*) from app.connection_oauth2_authorizations where connection_id='${connection}'),
        'forcedFences',(select bool_and(relforcerowsecurity) from pg_class where oid=any(array['app.connection_oauth2_clients'::regclass,'app.connection_oauth2_tokens'::regclass,'app.connection_oauth2_authorizations'::regclass])));`,
        ).trim(),
      );
      assert.deepEqual(facts, {
        client: 'restored',
        token,
        pending: 1,
        forcedFences: true,
      });
      const foreign = sql(
        target,
        `begin; set local role pertexo_app; select set_config('app.workspace_id','${randomUUID()}',true); select (select count(*) from app.connection_oauth2_clients)+(select count(*) from app.connection_oauth2_tokens)+(select count(*) from app.connection_oauth2_authorizations); rollback;`,
      )
        .trim()
        .split('\n');
      assert.equal(foreign.at(-2), '0');
    },
  };
}
