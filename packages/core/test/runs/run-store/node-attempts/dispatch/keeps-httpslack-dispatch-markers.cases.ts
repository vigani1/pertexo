import { it, expect } from 'vitest';

import { isConnectionFenceCurrent } from '../../../../../src/connections/runtime/dispatch.repository.js';

import {
  NodeAttemptConnectionFenceError,
  actorId,
  asOwner,
  asRuntime,
  nodeAttemptStore,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import {
  claimDispatchAttempt,
  seedDispatchConnection,
  dispatchBinding,
  seedSlackDispatchPublication,
} from '../fixture.js';

export function registerKeepsHTTPSlackDispatchMarkers(): void {
  it('keeps HTTP and Slack dispatch markers fenced across credential rotation', async () => {
    for (const target of [
      { providerKey: 'http', authType: 'http_headers' },
      { providerKey: 'slack', authType: 'slack_bot_token' },
    ] as const) {
      const connectionId = randomUUID();
      const secretVersionId = randomUUID();
      const rotatedSecretVersionId = randomUUID();
      await seedDispatchConnection({
        connectionId,
        providerKey: target.providerKey,
        authType: target.authType,
        secretVersionId,
      });
      const lease = await claimDispatchAttempt(
        `dispatch-${target.providerKey}`,
        {
          ...(target.providerKey === 'slack'
            ? {
                workflowVersionId:
                  await seedSlackDispatchPublication(connectionId),
              }
            : {}),
        },
      );
      const connectionFence = {
        connectionId,
        expectedProviderKey: target.providerKey,
        expectedAuthType: target.authType,
        secretVersionId,
      } as const;
      const providerDispatchBinding = dispatchBinding(
        target.providerKey,
        connectionId,
        secretVersionId,
      );
      const preflight = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        isConnectionFenceCurrent(client, workspaceA, {
          connectionId,
          providerKey: target.providerKey,
          authType: target.authType,
          secretVersionId,
        }),
      );
      expect(preflight).toBe(true);

      await asOwner(workspaceA, async (client) => {
        await client.query(
          `insert into app.connection_secret_versions (
               id,workspace_id,connection_id,kms_key_reference,
               encrypted_data_key,ciphertext,nonce,auth_tag,created_by
             ) values ($1,$2,$3,'kms','b','b',$4,$5,$6)`,
          [
            rotatedSecretVersionId,
            workspaceA,
            connectionId,
            'b'.repeat(16),
            'b'.repeat(22),
            actorId,
          ],
        );
        await client.query(
          `update app.connections set current_secret_version_id=$3,health_revision=health_revision+1
             where workspace_id=$1 and id=$2`,
          [workspaceA, connectionId, rotatedSecretVersionId],
        );
      });

      await expect(
        nodeAttemptStore.markDispatched({
          lease,
          connectionFence,
          providerDispatchBinding,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            dispatch_marked_at: Date | null;
            provider_dispatch_binding: string | null;
          }>(
            `select attempt.dispatch_marked_at,node.provider_dispatch_binding
               from app.node_attempts attempt
               join app.node_runs node on node.id=attempt.node_run_id
              where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceA, lease.attemptId],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            dispatch_marked_at: null,
            provider_dispatch_binding: null,
          },
        ],
      });

      const rotatedFence = {
        ...connectionFence,
        secretVersionId: rotatedSecretVersionId,
      };
      const rotatedBinding = dispatchBinding(
        target.providerKey,
        connectionId,
        rotatedSecretVersionId,
      );
      const dispatched = await nodeAttemptStore.markDispatched({
        lease,
        connectionFence: rotatedFence,
        providerDispatchBinding: rotatedBinding,
        signal: new AbortController().signal,
      });
      expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
      const verified = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          dispatch_marked_at: Date | null;
          provider_dispatch_binding: string | null;
        }>(
          `select attempt.dispatch_marked_at,node.provider_dispatch_binding
             from app.node_attempts attempt
             join app.node_runs node on node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [workspaceA, lease.attemptId],
        ),
      );
      expect(verified.rows).toHaveLength(1);
      expect(verified.rows[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(verified.rows[0]?.provider_dispatch_binding).toBe(rotatedBinding);
    }
  }, 30_000);
}
