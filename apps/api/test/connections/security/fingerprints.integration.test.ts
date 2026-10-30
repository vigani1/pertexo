import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'credential command fingerprints',
  () => {
    const api = useBetterAuthRealApi('credential_fingerprints', {
      connections: {
        config: {
          mode: 'self-managed',
          encryption: {
            current: {
              version: 'fixture-v1',
              key: Buffer.alloc(32, 77).toString('base64'),
            },
            previous: [],
          },
        },
      },
    });

    it('does not expose a credential verifier, replays the same request and conflicts on a changed credential', async () => {
      const email = `fingerprints-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: {
          name: 'Credential fingerprints',
          slug: `hash-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const { id: workspaceId } = workspace.json<{ id: string }>();
      const headers = { 'Idempotency-Key': randomUUID() };
      const payload = {
        providerKey: 'signing',
        name: 'Signing key',
        credential: { type: 'hmac_key', signingKey: 'fixture-demo-0042' },
      };
      const path = `/v1/workspaces/${workspaceId}/connections`;
      const created = await api.send('POST', path, {
        browser,
        headers,
        payload,
      });
      expect(created.statusCode, created.payload).toBe(201);
      const replay = await api.send('POST', path, {
        browser,
        headers,
        payload,
      });
      expect(replay.statusCode, replay.payload).toBe(201);
      expect(replay.json()).toEqual(created.json());
      const changed = await api.send('POST', path, {
        browser,
        headers,
        payload: {
          ...payload,
          credential: {
            ...payload.credential,
            signingKey: 'fixture-demo-0043',
          },
        },
      });
      expect(changed.statusCode, changed.payload).toBe(409);
      const records = await api
        .database()
        .query<{ request_hash: string }>(
          'select request_hash from app.idempotency_records where workspace_id = $1 and operation = $2',
          [workspaceId, 'connection.create'],
        );
      expect(records.rows).toHaveLength(1);
      const unkeyedVerifier = createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
      expect(records.rows[0]?.request_hash).not.toBe(unkeyedVerifier);
      const connection = created.json<{
        id: string;
        secretVersionId: string;
      }>();
      const rotation = {
        expectedSecretVersionId: connection.secretVersionId,
        credential: { type: 'hmac_key', signingKey: 'fixture-rotated-0042' },
      };
      const rotationHeaders = { 'Idempotency-Key': randomUUID() };
      const secretPath = `${path}/${connection.id}/secret`;
      const rotated = await api.send('PUT', secretPath, {
        browser,
        headers: rotationHeaders,
        payload: rotation,
      });
      expect(rotated.statusCode, rotated.payload).toBe(200);
      const rotationReplay = await api.send('PUT', secretPath, {
        browser,
        headers: rotationHeaders,
        payload: rotation,
      });
      expect(rotationReplay.statusCode, rotationReplay.payload).toBe(200);
      expect(rotationReplay.json()).toEqual(rotated.json());
      const conflictingRotation = await api.send('PUT', secretPath, {
        browser,
        headers: rotationHeaders,
        payload: {
          ...rotation,
          credential: {
            ...rotation.credential,
            signingKey: 'fixture-rotated-0043',
          },
        },
      });
      expect(conflictingRotation.statusCode, conflictingRotation.payload).toBe(
        409,
      );
      const rotations = await api
        .database()
        .query<{ request_hash: string }>(
          'select request_hash from app.idempotency_records where workspace_id=$1 and operation=$2',
          [workspaceId, 'connection.secret.rotate'],
        );
      expect(rotations.rows).toHaveLength(1);
      expect(rotations.rows[0]?.request_hash).not.toBe(
        createHash('sha256')
          .update(JSON.stringify({ connectionId: connection.id, ...rotation }))
          .digest('hex'),
      );
    });
  },
);
