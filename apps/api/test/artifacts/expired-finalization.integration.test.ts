import type * as TransferFixture from './artifact-transfer.fixture.js';
import type { mutationHeaders as HeadersForMutation } from './transfer-fixture/http.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createRunArtifactRetentionCoordinator } from '@pertexo/core/lifecycle';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
} from '@pertexo/database/testing';

describe.skipIf(process.env.API_ARTIFACT_INTEGRATION !== 'true')(
  'expired upload finalization over HTTP',
  () => {
    let transfer: typeof TransferFixture | undefined;
    let mutationHeaders: typeof HeadersForMutation;
    let database:
      ReturnType<typeof createDisposableDatabaseFixture> | undefined;
    const originalUrls = new Map<string, string>();
    beforeAll(async () => {
      const adminUrl = process.env.DATABASE_ADMIN_URL;
      if (adminUrl === undefined) throw new Error('Admin URL is required');
      database = createDisposableDatabaseFixture({
        adminUrl,
        databaseName: `pertexo_test_expired_upload_${randomUUID().replaceAll('-', '')}`,
        ownerRole: 'pertexo_owner',
        connectRoles: [
          'pertexo_app',
          'pertexo_migration',
          'pertexo_maintenance',
        ],
      });
      await database.create();
      for (const name of [
        'DATABASE_URL',
        'DATABASE_MIGRATION_URL',
        'DATABASE_MAINTENANCE_URL',
      ]) {
        const value = process.env[name];
        if (value === undefined) throw new Error(`${name} is required`);
        originalUrls.set(name, value);
        process.env[name] = database.databaseUrl(value);
      }
      await migrateDatabase({
        connectionString: process.env.DATABASE_MIGRATION_URL ?? '',
        appRole: 'pertexo_app',
        maintenanceRole: 'pertexo_maintenance',
        ownerRole: 'pertexo_owner',
      });
      ({ mutationHeaders } = await import('./transfer.support.js'));
      transfer = await import('./artifact-transfer.fixture.js');
      await transfer.prepareAuthenticatedArtifactTransferHTTPFixture();
    }, 60_000);
    afterAll(async () => {
      await transfer?.closeAuthenticatedArtifactTransferHTTPFixture();
      for (const [name, value] of originalUrls) process.env[name] = value;
      await database?.drop();
    });

    it('explains expiry after cleanup wins verification, without disclosing missing or foreign uploads', async () => {
      if (transfer === undefined) throw new Error('Upload fixture is required');
      const { fixture, begin, requestMetadata, signedPut } = transfer;
      const owner = await fixture.login('owner');
      const bytes = Buffer.from('late upload');
      const baseline = await fixture.readCapacity();
      const started = await begin(fixture, owner, requestMetadata(bytes));
      expect((await signedPut(started.upload, bytes)).ok).toBe(true);
      const maintenanceUrl = process.env.DATABASE_MAINTENANCE_URL;
      if (maintenanceUrl === undefined)
        throw new Error('Maintenance URL is required');
      const coordinator = createRunArtifactRetentionCoordinator(
        parseDatabaseConfig({
          connectionString: maintenanceUrl,
          max: 2,
        }),
        fixture.verificationStore,
      );
      fixture.afterNextUploadVerification(async () => {
        await fixture.expireArtifact(started.artifact.id);
        await expect(coordinator.processNext()).resolves.toMatchObject({
          artifactId: started.artifact.id,
          status: 'completed',
        });
      });
      const finalize = (id: string) =>
        fixture.application.inject({
          method: 'POST',
          url: `/v1/workspaces/${fixture.workspaceId}/artifacts/${id}/finalize`,
          headers: mutationHeaders(owner, randomUUID()),
          payload: {},
        });
      try {
        const late = await finalize(started.artifact.id);
        const expected = {
          status: 404,
          code: 'artifact.upload_unavailable',
          detail:
            'This upload expired or is no longer available. Upload the file again.',
        };
        expect(late.statusCode, late.payload).toBe(404);
        expect(late.json()).toMatchObject(expected);
        expect(await fixture.readArtifact(started.artifact.id)).toBeNull();
        expect(await fixture.readCapacity()).toEqual(baseline);
        expect((await finalize(started.artifact.id)).json()).toMatchObject(
          expected,
        );
        expect((await finalize(randomUUID())).json()).toMatchObject(expected);
        const foreignId = randomUUID();
        await fixture.withOwner(async (client) => {
          await client.query("select set_config('app.workspace_id',$1,true)", [
            fixture.otherWorkspaceId,
          ]);
          await client.query(
            "insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at) values($1,$2,'user-upload',$3,'text/plain',11,$4,'pending',clock_timestamp()+interval '1 day')",
            [
              foreignId,
              fixture.otherWorkspaceId,
              `workspaces/${fixture.otherWorkspaceId}/artifacts/${foreignId}`,
              'a'.repeat(64),
            ],
          );
        });
        expect((await finalize(foreignId)).json()).toMatchObject(expected);
        const expired = await begin(fixture, owner, requestMetadata(bytes));
        await fixture.expireArtifact(expired.artifact.id);
        expect((await finalize(expired.artifact.id)).json()).toMatchObject(
          expected,
        );
      } finally {
        await coordinator.close();
      }
    });
  },
);
