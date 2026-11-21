import { createConnectionStore } from '@pertexo/core/connections';
import { generatePersistedId } from '@pertexo/database/platform';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATIONS_DIRECTORY,
  migrateDatabase,
  parseDatabaseConfig,
  seedWorkspace,
} from '@pertexo/database/testing';
import {
  createConnectionEnvelopeEncryption,
  parseConnectionEncryptionConfig,
  type ConnectionSecretContext,
  type SealedConnectionSecret,
} from '@pertexo/secrets/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStackSetting } from '../../../../infrastructure/testing/test-stack.mjs';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

import { CLIENT_SECRET, credentials } from './auth-key-upgrade-fixture.js';

const PREVIOUS_HEAD = '0008_poll_pause.sql';
describe.runIf(betterAuthIntegrationEnabled)(
  'connection auth key migration',
  () => {
    const directory = join(tmpdir(), `pertexo-auth-key-${randomUUID()}`);
    beforeAll(async () => {
      await mkdir(directory);
      for (const name of await readdir(MIGRATIONS_DIRECTORY))
        if (/^\d{4}_.*\.sql$/u.test(name) && name <= PREVIOUS_HEAD)
          await copyFile(
            join(MIGRATIONS_DIRECTORY, name),
            join(directory, name),
          );
    });

    let upgraded: Awaited<ReturnType<typeof prepareUpgrade>>;
    const config = parseConnectionEncryptionConfig(
      {
        CONNECTION_ENCRYPTION_MODE: 'local',
        CONNECTION_LOCAL_KEY: randomBytes(32).toString('base64url'),
      },
      { deployed: false },
    );
    if (config === undefined) throw new Error('Missing upgrade fixture key');
    const { encryption } = createConnectionEnvelopeEncryption(config);
    const api = useBetterAuthRealApi('auth_key', {
      migrationDirectory: directory,
      afterMigration: async (databaseUrl) => {
        upgraded = await prepareUpgrade(databaseUrl);
      },
      connections: { config, oauth2: true },
    });
    afterAll(() => rm(directory, { recursive: true, force: true }));

    async function prepareUpgrade(databaseUrl: (base: string) => string) {
      const { workspaceId, ownerId } = await seedWorkspace(api.database());
      const store = createConnectionStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(testStackSetting('DATABASE_URL')),
        }),
      );
      const originals = [];
      try {
        for (const [providerKey, credential] of credentials) {
          const connectionId = generatePersistedId();
          const secretVersionId = generatePersistedId();
          const bytes = new TextEncoder().encode(
            JSON.stringify(
              credential.type === 'oauth2'
                ? { type: 'oauth2', clientSecret: credential.clientSecret }
                : credential,
            ),
          );
          const sealed = await encryption.seal(bytes, {
            workspaceId,
            connectionId,
            secretVersionId,
          });
          await store.createConnection({
            workspaceId,
            actorId: ownerId,
            connectionId,
            secretVersionId,
            providerKey,
            name: `Upgrade ${credential.type} ${String(originals.length)}`,
            sealed,
            idempotencyKey: randomUUID(),
            requestHash: randomBytes(32).toString('hex'),
            ...(credential.type === 'oauth2'
              ? {
                  authType: credential.type,
                  oauth2Settings: credential.settings,
                }
              : { authType: credential.type }),
          });
          originals.push({
            credential,
            record: { id: connectionId, secretVersionId },
          });
        }
      } finally {
        await store.close();
      }
      const active = originals.at(-1)?.record;
      if (active === undefined)
        throw new Error('Missing OAuth2 upgrade fixture');
      const tokenId = await grantOAuth2(workspaceId, active);
      await api.database().query(
        `insert into app.connection_oauth2_authorizations
         (workspace_id,connection_id,state_digest,binding_digest,started_by,secret_version_id,expires_at)
       select workspace_id,id,$2,$3,created_by,current_secret_version_id,statement_timestamp()+interval '10 minutes'
         from app.connections where id=$1`,
        [active.id, randomBytes(32), randomBytes(32)],
      );

      const before = await snapshot(workspaceId);
      expect(before?.connections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: active.id, status: 'active' }),
          expect.objectContaining({
            auth_type: 'oauth2',
            status: 'reauthorization_required',
          }),
        ]),
      );
      expect(before).toMatchObject({
        connection_oauth2_tokens: [expect.objectContaining({ id: tokenId })],
        connection_oauth2_authorizations: [
          expect.objectContaining({ connection_id: active.id }),
        ],
      });

      await expect(
        api
          .database()
          .query(
            "update app.connections set auth_type='future_auth' where id=$1",
            [active.id],
          ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'connections_auth_type_valid',
      });

      await migrateDatabase({
        connectionString: databaseUrl(
          testStackSetting('DATABASE_MIGRATION_URL'),
        ),
        appRole: 'pertexo_app',
        maintenanceRole: 'pertexo_maintenance',
        ownerRole: 'pertexo_owner',
      });
      return { workspaceId, originals, active, tokenId, before };
    }

    it('preserves stored rows, credentials and OAuth2 grant state and permits rotation after upgrade', async () => {
      const { workspaceId, originals, active, tokenId, before } = upgraded;
      const w = await workspace(workspaceId);
      expect(await snapshot(w.workspaceId)).toEqual(before);
      for (const malformed of ['UPPER', '1leading', 'has-dash', '']) {
        await expect(
          api
            .database()
            .query('update app.connections set auth_type=$1 where id=$2', [
              malformed,
              active.id,
            ]),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'connections_auth_type_format',
        });
      }
      const token = await openSecret('connection_oauth2_tokens', {
        workspaceId: w.workspaceId,
        connectionId: active.id,
        secretVersionId: tokenId,
      });
      expect(token).toEqual({
        accessToken: 'upgrade-access',
        refreshToken: 'upgrade-refresh',
      });

      for (const { credential, record } of originals) {
        const found = await api.send('GET', `${w.base}/${record.id}`, {
          browser: w.browser,
        });
        expect(found.statusCode, found.payload).toBe(200);
        expect(found.json()).toMatchObject({
          id: record.id,
          secretVersionId: record.secretVersionId,
          authType: credential.type,
          ...(record.id === active.id
            ? { status: 'active', grant: { renewable: true } }
            : {}),
        });
        expect(
          await openSecret('connection_secret_versions', {
            workspaceId: w.workspaceId,
            connectionId: record.id,
            secretVersionId: record.secretVersionId,
          }),
        ).toMatchObject(
          credential.type === 'oauth2'
            ? { type: 'oauth2', clientSecret: CLIENT_SECRET }
            : credential,
        );
        if (credential.type === 'hmac_key') {
          const tested = await w.command('POST', `/${record.id}/test`, {
            providerKey: 'signing',
          });
          expect(tested.statusCode, tested.payload).toBe(200);
          expect(tested.json()).toMatchObject({ outcome: { ok: true } });
        }
        const rotated = await w.command('PUT', `/${record.id}/secret`, {
          expectedSecretVersionId: record.secretVersionId,
          credential,
        });
        expect(rotated.statusCode, rotated.payload).toBe(200);
        expect(rotated.json<Connection>().secretVersionId).not.toBe(
          record.secretVersionId,
        );
      }
    });

    async function workspace(workspaceId: string) {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      await api.database().query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         select $1,id,'admin','active' from app.users where email=$2`,
        [workspaceId, email],
      );
      const headers = () => ({ 'idempotency-key': randomUUID() });
      const base = `/v1/workspaces/${workspaceId}/connections`;
      return {
        workspaceId,
        browser,
        base,
        command: (method: 'POST' | 'PUT', path: string, payload: object) =>
          api.send(method, base + path, {
            browser,
            headers: headers(),
            payload,
          }),
      };
    }

    async function grantOAuth2(workspaceId: string, record: Connection) {
      const id = randomUUID();
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          accessToken: 'upgrade-access',
          refreshToken: 'upgrade-refresh',
        }),
      );
      const sealed = await encryption.seal(bytes, {
        workspaceId,
        connectionId: record.id,
        secretVersionId: id,
      });
      await api.database().query(
        `insert into app.connection_oauth2_tokens
         (id,workspace_id,connection_id,secret_version_id,kms_key_reference,encrypted_data_key,
          ciphertext,nonce,auth_tag,authorized_at,issued_at,renewable)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,statement_timestamp(),statement_timestamp(),true)`,
        [
          id,
          workspaceId,
          record.id,
          record.secretVersionId,
          sealed.kmsKeyReference,
          sealed.encryptedDataKey,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
        ],
      );
      await api
        .database()
        .query(
          "update app.connections set status='active', last_error_code=null where id=$1",
          [record.id],
        );
      return id;
    }

    async function snapshot(workspaceId: string) {
      const { rows } = await api.database().query<Record<string, unknown>>(
        `select
         (select jsonb_agg(c order by c.id) from app.connections c where workspace_id=$1) connections,
         (select jsonb_agg(s order by s.id) from app.connection_secret_versions s where workspace_id=$1) connection_secret_versions,
         (select jsonb_agg(c order by c.connection_id) from app.connection_oauth2_clients c where workspace_id=$1) connection_oauth2_clients,
         (select jsonb_agg(t order by t.id) from app.connection_oauth2_tokens t where workspace_id=$1) connection_oauth2_tokens,
         (select jsonb_agg(a order by a.connection_id) from app.connection_oauth2_authorizations a where workspace_id=$1) connection_oauth2_authorizations`,
        [workspaceId],
      );
      return rows.at(0);
    }

    async function openSecret(
      table: 'connection_secret_versions' | 'connection_oauth2_tokens',
      context: ConnectionSecretContext,
    ) {
      const { rows } = await api.database().query<SealedConnectionSecret>(
        `select kms_key_reference "kmsKeyReference", encrypted_data_key "encryptedDataKey",
              ciphertext, nonce, auth_tag tag from app.${table} where id=$1`,
        [context.secretVersionId],
      );
      const sealed = rows.at(0);
      if (sealed === undefined)
        throw new Error('Missing sealed upgrade fixture');
      const plaintext = await encryption.open(sealed, context);
      try {
        return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
      } finally {
        plaintext.fill(0);
      }
    }
  },
);

type Connection = Readonly<{ id: string; secretVersionId: string }>;
