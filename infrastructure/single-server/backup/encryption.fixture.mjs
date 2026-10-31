import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createConnectionEnvelopeEncryption,
  createWebhookTriggerEnvelopeEncryption,
  parseConnectionEncryptionConfig,
  parseCallbackKeyConfig,
  createCallbackTokenKeys,
  callbackTokenHash,
} from '../../../packages/integrations/dist/server.js';

const quoted = (value) => "'" + value.replaceAll("'", "''") + "'";
const insert = (table, fields) =>
  'INSERT INTO app.' +
  table +
  '(' +
  Object.keys(fields).join(',') +
  ') VALUES(' +
  Object.values(fields).map(quoted).join(',') +
  ');';

export async function seedEncryptedRecoveryFixture(sql, database) {
  const keys = [
    randomBytes(32).toString('base64'),
    randomBytes(32).toString('base64'),
  ];
  const callbackKeys = [
    randomBytes(32).toString('base64'),
    randomBytes(32).toString('base64'),
  ];
  const environment = {
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    CALLBACK_TOKEN_KEY: callbackKeys[1],
    CALLBACK_TOKEN_KEY_VERSION: '2',
    CALLBACK_TOKEN_PREVIOUS_KEYS: JSON.stringify([
      { version: '1', key: callbackKeys[0] },
    ]),
    NODE_ENV: 'production',
    CONNECTION_ENCRYPTION_MODE: 'self-managed',
    CONNECTION_SELF_MANAGED_KEY: keys[1],
    CONNECTION_SELF_MANAGED_KEY_VERSION: '2',
    CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify([
      { version: '1', key: keys[0] },
    ]),
  };
  const first = parseConnectionEncryptionConfig(
    {
      ...environment,
      CONNECTION_SELF_MANAGED_KEY: keys[0],
      CONNECTION_SELF_MANAGED_KEY_VERSION: '1',
      CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: undefined,
    },
    true,
  );
  const current = parseConnectionEncryptionConfig(environment, true);
  const actor = randomUUID(),
    connectionWorkspace = randomUUID(),
    webhookWorkspace = randomUUID();
  const connection = randomUUID(),
    workflow = randomUUID(),
    version = randomUUID(),
    trigger = randomUUID();
  const records = [];
  for (const [kind, workspaceId, resourceId] of [
    ['connection', connectionWorkspace, connection],
    ['webhook', webhookWorkspace, trigger],
  ]) {
    for (const config of [first, current]) {
      const secretVersionId = randomUUID();
      const context =
        kind === 'connection'
          ? { workspaceId, connectionId: resourceId, secretVersionId }
          : { workspaceId, triggerId: resourceId, secretVersionId };
      const runtime =
        kind === 'connection'
          ? createConnectionEnvelopeEncryption(config)
          : createWebhookTriggerEnvelopeEncryption(config);
      const plaintext =
        kind === 'connection'
          ? Buffer.from(
              'recovered-credential-' + config.encryption.current.version,
            )
          : randomBytes(32);
      try {
        const sealed = await runtime.encryption.seal(
          Buffer.from(plaintext),
          context,
        );
        records.push({
          kind,
          workspaceId,
          resourceId,
          secretVersionId,
          context,
          plaintext,
          sealed,
        });
      } finally {
        runtime.close();
      }
    }
  }
  const callbackConfig = parseCallbackKeyConfig(environment, true);
  const tokenKeys = createCallbackTokenKeys(callbackConfig);
  const callbackRun = randomUUID();
  const callbacks = ['1', '2'].map((keyVersion) => {
    const id = randomUUID();
    return {
      id,
      keyVersion,
      tokenHash: callbackTokenHash(
        tokenKeys.material({ id }, keyVersion).token,
      ),
    };
  });
  tokenKeys.close();
  const statements = [
    'BEGIN;',
    insert('users', {
      id: actor,
      email: 'recovery@example.test',
      display_name: 'Recovery fixture',
      status: 'active',
    }),
    ...[connectionWorkspace, webhookWorkspace].map((id) =>
      insert('workspaces', {
        id,
        name: 'Recovery fixture',
        slug: 'recovery-' + id,
        status: 'active',
        created_by: actor,
      }),
    ),
    insert('connections', {
      id: connection,
      workspace_id: connectionWorkspace,
      provider_key: 'http',
      name: 'Retained revoked connection',
      auth_type: 'http_headers',
      status: 'revoked',
      current_secret_version_id: records.findLast(
        (r) => r.kind === 'connection',
      ).secretVersionId,
      created_by: actor,
    }),
    insert('workflows', {
      id: workflow,
      workspace_id: webhookWorkspace,
      name: 'Archived webhook workflow',
      lifecycle_status: 'archived',
      created_by: actor,
    }),
    insert('workflow_versions', {
      id: version,
      workspace_id: webhookWorkspace,
      workflow_id: workflow,
      version_number: '1',
      graph_json: '{}',
      checksum: 'wf:sha256:' + '0'.repeat(64),
      executable_json: '{}',
      published_by: actor,
    }),
    insert('workflow_triggers', {
      id: trigger,
      workspace_id: webhookWorkspace,
      workflow_id: workflow,
      workflow_version_id: version,
      node_id: 'webhook',
      kind: 'webhook',
      desired_config: '{}',
      config_fingerprint: 'trigger:sha256:' + '0'.repeat(64),
      status: 'disabled',
    }),
    ...records.map((record) =>
      insert(
        record.kind === 'connection'
          ? 'connection_secret_versions'
          : 'webhook_trigger_secret_versions',
        {
          id: record.secretVersionId,
          workspace_id: record.workspaceId,
          ...(record.kind === 'connection'
            ? { connection_id: record.resourceId }
            : {
                trigger_id: record.resourceId,
                workflow_id: workflow,
                node_id: 'webhook',
              }),
          kms_key_reference: record.sealed.kmsKeyReference,
          encrypted_data_key: record.sealed.encryptedDataKey,
          ciphertext: record.sealed.ciphertext,
          nonce: record.sealed.nonce,
          auth_tag: record.sealed.tag ?? record.sealed.authTag,
          created_by: actor,
        },
      ),
    ),
    "SELECT set_config('app.workspace_id'," +
      quoted(webhookWorkspace) +
      ',true);',
    insert('workflow_runs', {
      id: callbackRun,
      workspace_id: webhookWorkspace,
      workflow_id: workflow,
      workflow_version_id: version,
      trigger_type: 'manual',
      status: 'waiting',
      started_at: new Date().toISOString(),
    }),
    ...callbacks.map((callback) =>
      insert('pending_run_tasks', {
        id: callback.id,
        workspace_id: webhookWorkspace,
        run_id: callbackRun,
        workflow_version_id: version,
        invocation_key: 'callback:wait-' + callback.keyVersion,
        kind: 'callback',
        status: 'prepared',
        config: JSON.stringify({
          mode: 'callback',
          timeoutSeconds: 3600,
          authentication: { mode: 'secret_url', allowedOrigins: [] },
        }),
        callback_node_id: 'wait-' + callback.keyVersion,
        callback_scope: '[]',
        callback_scope_hash: createHash('sha256').update('[]').digest('hex'),
        callback_token_hash: callback.tokenHash,
        callback_key_version: callback.keyVersion,
      }),
    ),
    'COMMIT;',
  ];
  sql(database, statements.join('\n'));
  return {
    environment,
    unavailable: [
      { ...environment, CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: undefined },
      {
        ...environment,
        CONNECTION_SELF_MANAGED_KEY: randomBytes(32).toString('base64'),
      },
    ],
    async openRestored(target) {
      const restoredCallbacks = JSON.parse(
        sql(
          target,
          "SELECT json_agg(json_build_object('id',id,'keyVersion',callback_key_version,'tokenHash',callback_token_hash)) FROM app.pending_run_tasks WHERE kind='callback';",
        ),
      );
      const restoredKeys = createCallbackTokenKeys(
        parseCallbackKeyConfig(environment, true),
      );
      try {
        for (const callback of restoredCallbacks)
          assert.equal(
            callbackTokenHash(
              restoredKeys.material(callback, callback.keyVersion).token,
            ),
            callback.tokenHash,
          );
      } finally {
        restoredKeys.close();
      }

      const config = parseConnectionEncryptionConfig(environment, true);
      for (const record of records) {
        const table =
          record.kind === 'connection'
            ? 'connection_secret_versions'
            : 'webhook_trigger_secret_versions';
        const tag = record.kind === 'connection' ? 'tag' : 'authTag';
        const row = JSON.parse(
          sql(
            target,
            "SELECT json_build_object('kmsKeyReference',kms_key_reference,'encryptedDataKey',encrypted_data_key,'ciphertext',ciphertext,'nonce',nonce,'" +
              tag +
              "',auth_tag) FROM app." +
              table +
              ' WHERE id=' +
              quoted(record.secretVersionId) +
              ';',
          ),
        );
        const runtime =
          record.kind === 'connection'
            ? createConnectionEnvelopeEncryption(config)
            : createWebhookTriggerEnvelopeEncryption(config);
        let plaintext;
        try {
          plaintext = await runtime.encryption.open(row, record.context);
          assert.deepEqual(Buffer.from(plaintext), record.plaintext);
        } finally {
          plaintext?.fill(0);
          runtime.close();
        }
      }
    },
    keepWebhooksOnly(target) {
      sql(
        target,
        'BEGIN; DELETE FROM app.connection_secret_versions; DELETE FROM app.connections; COMMIT;',
      );
    },
    callbackUnavailable: [
      { ...environment, CALLBACK_TOKEN_PREVIOUS_KEYS: undefined },
      {
        ...environment,
        CALLBACK_TOKEN_KEY: randomBytes(32).toString('base64'),
      },
    ],
    masterKeys: [...keys, ...callbackKeys],
  };
}
