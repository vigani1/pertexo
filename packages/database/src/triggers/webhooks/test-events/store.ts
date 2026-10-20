import { appendAuditFact } from '../../../governance/audit/append.js';
import type { PoolClient } from 'pg';
import { webhookAuthenticationSchema } from '@pertexo/contracts';
import { webhookRunInput } from '@pertexo/nodes-core';
import type { DatabaseConfig } from '../../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import { withTenantScopedClient } from '../../../tenant-access/transactions.js';
import { inlineSampleOutput } from '../../../authoring/step-samples/records.js';
import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import { WorkflowStepSampleError } from '../../../authoring/step-samples/contract.js';
import { WorkflowNotFoundError } from '../../../authoring/workflows/errors.js';
import { WebhookIngressRateLimitExceededError } from '../errors.js';
import { testEventDraft } from './authority.js';
import {
  WebhookTestEventError,
  type TestEventScope,
  type WebhookTestEventStore,
} from './contract.js';

interface Row {
  id: string;
  workspace_id: string;
  workflow_id: string;
  node_id: string;
  created_by: string;
  endpoint_key_hash: string;
  binding: string;
  authentication: unknown;
  kms_key_reference: string;
  encrypted_data_key: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  output_ref: string | null;
  expires_at: Date;
  expired: boolean;
  database_time: Date;
}
const columns =
  '*,expires_at<=clock_timestamp() expired,clock_timestamp() database_time';
const scopeOf = (r: Row): TestEventScope => ({
  workspaceId: r.workspace_id,
  workflowId: r.workflow_id,
  nodeId: r.node_id,
  actorId: r.created_by,
});

export function createWebhookTestEventStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WebhookTestEventStore {
  const lease = acquireDatabasePool(config, runtime);
  const transact = <T>(
    input: TestEventScope,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withTenantScopedClient(
      lease.pool,
      { workspaceId: input.workspaceId, actorId: input.actorId },
      work,
      input.signal === undefined ? {} : { signal: input.signal },
    );
  const find = async (client: PoolClient, scope: TestEventScope, id: string) =>
    (
      await client.query<Row>(
        `select ${columns} from app.webhook_test_events where workspace_id=$1 and workflow_id=$2 and node_id=$3 and created_by=$4 and id=$5 for update`,
        [scope.workspaceId, scope.workflowId, scope.nodeId, scope.actorId, id],
      )
    ).rows[0];
  return {
    start: (input) =>
      transact(input, async (client) => {
        const draft = await testEventDraft(client, input);
        if (draft.revision !== input.expectedDraftRevision)
          throw new WebhookTestEventError('changed');
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1,0))',
          [`webhook-test-events:${input.workspaceId}`],
        );
        await client.query(
          'delete from app.webhook_test_events where workspace_id=$1 and (workflow_id=$2 or expires_at<=clock_timestamp())',
          [input.workspaceId, input.workflowId],
        );
        const quota = await client.query<{ count: string }>(
          'select count(*)::text count from app.webhook_test_events where workspace_id=$1',
          [input.workspaceId],
        );
        if (Number(quota.rows[0]?.count) >= 10)
          throw new WebhookTestEventError('limit_reached');
        const s = input.secret;
        const result = await client.query<{ expires_at: Date }>(
          `insert into app.webhook_test_events(id,workspace_id,workflow_id,node_id,created_by,endpoint_key_hash,binding,authentication,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+interval '120 seconds') returning expires_at`,
          [
            input.id,
            input.workspaceId,
            input.workflowId,
            input.nodeId,
            input.actorId,
            input.endpointKeyHash,
            draft.binding,
            JSON.stringify(input.authentication),
            s.kmsKeyReference,
            s.encryptedDataKey,
            s.ciphertext,
            s.nonce,
            s.authTag,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('Test listener was not created');
        await appendAuditFact(client, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: 'webhook.test.listen',
          targetType: 'workflow',
          targetId: input.workflowId,
          metadata: {
            nodeId: input.nodeId,
            authenticationMode: input.authentication.mode,
          },
        });
        return { expiresAt: row.expires_at.toISOString() };
      }),
    get: (input) =>
      transact(input, async (client) => {
        const draft = await testEventDraft(client, input);
        const row = await find(client, input, input.id);
        if (row === undefined || row.expired)
          return { state: 'expired', expiresAt: null, output: null };
        if (row.binding !== draft.binding)
          return {
            state: 'changed',
            expiresAt: row.expires_at.toISOString(),
            output: null,
          };
        return {
          state: row.output_ref === null ? 'waiting' : 'captured',
          expiresAt: row.expires_at.toISOString(),
          output:
            row.output_ref === null
              ? null
              : parseStoredExecutionValue(row.output_ref),
        };
      }),
    stop: (input) =>
      transact(input, async (client) => {
        await testEventDraft(client, input);
        await client.query(
          'delete from app.webhook_test_events where workspace_id=$1 and workflow_id=$2 and node_id=$3 and created_by=$4 and id=$5',
          [
            input.workspaceId,
            input.workflowId,
            input.nodeId,
            input.actorId,
            input.id,
          ],
        );
      }),
    resolve: async (hash) => {
      const resolution = await lease.pool.query<{
        workspace_id: string;
        id: string;
      }>('select * from app.resolve_webhook_test_event($1::char(64))', [hash]);
      const resolved = resolution.rows[0];
      if (resolved === undefined) return null;
      try {
        return await withTenantScopedClient(
          lease.pool,
          { workspaceId: resolved.workspace_id },
          async (client) => {
            const row = (
              await client.query<Row>(
                `select ${columns} from app.webhook_test_events where workspace_id=$1 and id=$2 and endpoint_key_hash=$3 and output_ref is null`,
                [resolved.workspace_id, resolved.id, hash],
              )
            ).rows[0];
            if (row === undefined || row.expired) return null;
            const draft = await testEventDraft(client, scopeOf(row));
            if (draft.binding !== row.binding) return null;
            return {
              endpointId: row.id,
              endpointKeyHash: hash,
              workspaceId: row.workspace_id,
              triggerId: row.id,
              workflowId: row.workflow_id,
              nodeId: row.node_id,
              databaseTime: row.database_time,
              authentication: webhookAuthenticationSchema.parse(
                row.authentication,
              ),
              currentSecret: {
                id: row.id,
                kmsKeyReference: row.kms_key_reference,
                encryptedDataKey: row.encrypted_data_key,
                ciphertext: row.ciphertext,
                nonce: row.nonce,
                authTag: row.auth_tag,
              },
            };
          },
        );
      } catch (error) {
        if (
          error instanceof WorkflowNotFoundError ||
          error instanceof WebhookTestEventError
        )
          return null;
        throw error;
      }
    },
    consume: async (reference) => {
      const allowed = await withTenantScopedClient(
        lease.pool,
        { workspaceId: reference.workspaceId },
        (client) =>
          client.query(
            `update app.webhook_test_events set attempts=attempts+1 where workspace_id=$1 and id=$2 and attempts<60 and expires_at>clock_timestamp() and output_ref is null returning id`,
            [reference.workspaceId, reference.endpointId],
          ),
      );
      if (allowed.rowCount !== 1) {
        const limited = await withTenantScopedClient(
          lease.pool,
          { workspaceId: reference.workspaceId },
          (client) =>
            client.query(
              'select 1 from app.webhook_test_events where workspace_id=$1 and id=$2 and attempts>=60 and expires_at>clock_timestamp() and output_ref is null',
              [reference.workspaceId, reference.endpointId],
            ),
        );
        if (limited.rowCount === 1)
          throw new WebhookIngressRateLimitExceededError(60);
        throw new WebhookTestEventError('unavailable');
      }
    },
    capture: async (reference, request) =>
      withTenantScopedClient(
        lease.pool,
        { workspaceId: reference.workspaceId },
        async (client) => {
          // Read authority before the row lock, matching management's lock order.
          const candidate = (
            await client.query<Row>(
              `select ${columns} from app.webhook_test_events where workspace_id=$1 and id=$2`,
              [reference.workspaceId, reference.endpointId],
            )
          ).rows[0];
          if (candidate === undefined) return false;
          let draft;
          try {
            draft = await testEventDraft(client, scopeOf(candidate));
          } catch (error) {
            if (
              error instanceof WorkflowNotFoundError ||
              error instanceof WebhookTestEventError
            )
              return false;
            throw error;
          }
          const row = await find(client, scopeOf(candidate), candidate.id);
          if (
            row === undefined ||
            row.expired ||
            row.output_ref !== null ||
            row.binding !== draft.binding
          )
            return false;
          let output;
          try {
            output = inlineSampleOutput({
              kind: 'inline',
              value: webhookRunInput(draft.config.runInput, request),
            });
          } catch (error) {
            if (error instanceof WorkflowStepSampleError)
              throw new WebhookTestEventError('value_invalid');
            throw error;
          }
          await client.query(
            `update app.webhook_test_events set output_ref=$3,received_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes' where workspace_id=$1 and id=$2`,
            [reference.workspaceId, reference.endpointId, output],
          );
          return true;
        },
      ),
    close: () => lease.close(),
  };
}
