import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createConnectionEnvelopeEncryption,
  parseConnectionEncryptionConfig,
} from '../../../packages/integrations/dist/server.js';

const CLIENT_SECRET = 'restored-client-secret';
const TOKENS = JSON.stringify({ accessToken: 'restored-access-token' });

/**
 * A connected OAuth2 connection, sealed under the fixture's real keys, with its
 * consent pending. A restored database must keep all of it, still openable and
 * behind the same row security.
 */
export async function seedOAuth2RecoveryFixture(sql, database, environment) {
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
  const contextOf = (secretVersionId) => ({
    workspaceId: source.workspace,
    connectionId: connection,
    secretVersionId,
  });
  const runtime = createConnectionEnvelopeEncryption(
    parseConnectionEncryptionConfig(environment, true),
  );
  const sealedColumns = async (plaintext, secretVersionId) => {
    const sealed = await runtime.encryption.seal(
      Buffer.from(plaintext),
      contextOf(secretVersionId),
    );
    return `'${sealed.kmsKeyReference}','${sealed.encryptedDataKey}','${sealed.ciphertext}','${sealed.nonce}','${sealed.tag}'`;
  };
  const clientSecret = await sealedColumns(CLIENT_SECRET, version);
  const tokens = await sealedColumns(TOKENS, token);
  runtime.close();
  sql(
    database,
    `begin;
    set constraints all deferred;
    insert into app.users(id,email,display_name) values('${member}','${member}@example.test','Restored OAuth2 starter');
    insert into app.workspace_memberships(workspace_id,user_id,role,status) values('${source.workspace}','${member}','owner','active');
    insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
      values('${connection}','${source.workspace}','http','Restored OAuth2','oauth2','active','${version}','${source.creator}');
    insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
      values('${version}','${source.workspace}','${connection}',${clientSecret},'${source.creator}');
    insert into app.connection_oauth2_clients(workspace_id,connection_id,secret_version_id,settings)
      values('${source.workspace}','${connection}','${version}','{"clientId":"restored"}');
    insert into app.connection_oauth2_tokens(id,workspace_id,connection_id,secret_version_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,authorized_at,issued_at,renewable)
      values('${token}','${source.workspace}','${connection}','${version}',${tokens},clock_timestamp(),clock_timestamp(),true);
    insert into app.connection_oauth2_authorizations(workspace_id,connection_id,state_digest,binding_digest,started_by,secret_version_id,expires_at)
      values('${source.workspace}','${connection}',decode('${randomBytes(32).toString('hex')}','hex'),decode('${randomBytes(32).toString('hex')}','hex'),'${member}','${version}',clock_timestamp()+interval '600 seconds');
    commit;`,
  );
  return {
    /** The two rows `verify-stored-keys` must now count, beside the other fixtures'. */
    connectionKeys: 2,
    async verify(target) {
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

      const restored = createConnectionEnvelopeEncryption(
        parseConnectionEncryptionConfig(environment, true),
      );
      const opened = async (table, secretVersionId) => {
        const row = JSON.parse(
          sql(
            target,
            `select json_build_object('kmsKeyReference',kms_key_reference,'encryptedDataKey',encrypted_data_key,'ciphertext',ciphertext,'nonce',nonce,'tag',auth_tag) from app.${table} where id='${secretVersionId}';`,
          ),
        );
        const plaintext = await restored.encryption.open(
          row,
          contextOf(secretVersionId),
        );
        return Buffer.from(plaintext).toString();
      };
      try {
        assert.equal(
          await opened('connection_secret_versions', version),
          CLIENT_SECRET,
        );
        assert.equal(await opened('connection_oauth2_tokens', token), TOKENS);
      } finally {
        restored.close();
      }
    },
  };
}
