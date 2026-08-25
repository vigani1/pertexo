import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import {
  lockExpectedCompatibilityReleaseSet,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';
import { acceptWorkflowRun } from './execution-acceptance.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from './published-workflow-reader.js';
import {
  readHealth,
  refreshWorkflowActivation,
  type WorkflowTriggerHealth,
} from './workflow-triggers.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from './workspace.js';

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sealedSchema = z
  .object({
    id: z.uuid(),
    schemaVersion: z.literal(1),
    kmsKeyReference: z.string().min(1).max(2048),
    encryptedDataKey: z.string().min(1),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1).max(64),
    authTag: z.string().min(1).max(64),
  })
  .strict();

export type SealedWebhookTriggerSecret = Readonly<z.input<typeof sealedSchema>>;
export type WebhookCheckpointFactory = (
  projection: PublishedWorkflowV2Projection,
  currentCompatibilityRelease: CompatibilityReleaseExpectation,
) => Readonly<{ engineVersion: string; checkpoint: unknown }>;

type Command = Readonly<{
  workspaceId: string;
  actorId: string;
  triggerId: string;
  idempotencyKey: string;
  requestHash: string;
}>;

export type WebhookVerificationReference = Readonly<{
  endpointId: string;
  endpointKeyHash: string;
  workspaceId: string;
  triggerId: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  databaseTime: Date;
  currentSecret: SealedWebhookTriggerSecret;
  previousSecret?: SealedWebhookTriggerSecret & Readonly<{ validUntil: Date }>;
}>;

export type AcceptVerifiedWebhookDeliveryInput = Readonly<{
  verification: WebhookVerificationReference;
  verifiedSecretVersionId: string;
  requestFingerprint: string;
  idempotencyKeyHash?: string;
  payload: unknown;
  checkpointFactory: WebhookCheckpointFactory;
  traceparent?: string;
}>;

export interface WebhookTriggerDatabase {
  provision(
    input: Command &
      Readonly<{
        endpointId: string;
        endpointKeyHash: string;
        secret: SealedWebhookTriggerSecret;
      }>,
  ): Promise<WorkflowTriggerHealth>;
  rotateEndpoint(
    input: Command & Readonly<{ endpointKeyHash: string }>,
  ): Promise<WorkflowTriggerHealth>;
  rotateSecret(
    input: Command & Readonly<{ secret: SealedWebhookTriggerSecret }>,
  ): Promise<WorkflowTriggerHealth>;
  getHealth(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
    }>,
  ): Promise<readonly WorkflowTriggerHealth[]>;
  resolveVerification(
    endpointKeyHash: string,
  ): Promise<WebhookVerificationReference | null>;
  acceptVerifiedDelivery(
    input: AcceptVerifiedWebhookDeliveryInput,
  ): Promise<Readonly<{ runId: string; replayed: boolean }>>;
  close(): Promise<void>;
}

export class WebhookTriggerNotFoundError extends Error {
  public override readonly name = 'WebhookTriggerNotFoundError';
}
export class WebhookTriggerIdempotencyConflictError extends Error {
  public override readonly name = 'WebhookTriggerIdempotencyConflictError';
}
export class WebhookDeliveryReplayMismatchError extends Error {
  public override readonly name = 'WebhookDeliveryReplayMismatchError';
}
export class WebhookDeliveryIneligibleError extends Error {
  public override readonly name = 'WebhookDeliveryIneligibleError';
}

function keyHash(value: string): string {
  return createHash('sha256')
    .update(z.string().min(1).max(128).parse(value))
    .digest('hex');
}

async function authorizeManager(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
      join app.workspaces workspace on workspace.id=membership.workspace_id
      join app.users actor on actor.id=membership.user_id
     where membership.workspace_id=$1 and membership.user_id=$2
       and membership.status='active' and membership.role in ('owner','admin')
       and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1) throw new WebhookTriggerNotFoundError();
}

async function authorizeReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
      join app.workspaces workspace on workspace.id=membership.workspace_id
      join app.users actor on actor.id=membership.user_id
     where membership.workspace_id=$1 and membership.user_id=$2
       and membership.status='active'
       and membership.role in ('owner','admin','builder')
       and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1) throw new WebhookTriggerNotFoundError();
}

async function claimCommand(
  client: PoolClient,
  input: Command,
  operation: string,
): Promise<boolean> {
  const digest = keyHash(input.idempotencyKey);
  const requestHash = digestSchema.parse(input.requestHash);
  await client.query(
    `insert into app.idempotency_records
      (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref,expires_at)
     values($1,$2,$3,$4,$5,$6,'in_progress',$7,'{}'::jsonb,clock_timestamp()+interval '24 hours')
     on conflict(workspace_id,operation,scope,key_hash) do nothing`,
    [
      randomUUID(),
      input.workspaceId,
      operation,
      `${input.actorId}:${input.triggerId}`,
      digest,
      requestHash,
      input.triggerId,
    ],
  );
  const result = await client.query<{ request_hash: string; status: string }>(
    `select request_hash,status from app.idempotency_records
      where workspace_id=$1 and operation=$2 and scope=$3 and key_hash=$4 for update`,
    [
      input.workspaceId,
      operation,
      `${input.actorId}:${input.triggerId}`,
      digest,
    ],
  );
  const claim = result.rows[0];
  if (claim === undefined)
    throw new Error('Webhook command claim is unavailable');
  if (claim.request_hash !== requestHash)
    throw new WebhookTriggerIdempotencyConflictError();
  return claim.status === 'completed';
}

async function completeCommand(
  client: PoolClient,
  input: Command,
  operation: string,
): Promise<void> {
  await client.query(
    `update app.idempotency_records set status='completed',result_ref=$1::jsonb,
       updated_at=clock_timestamp() where workspace_id=$2 and operation=$3
       and scope=$4 and key_hash=$5`,
    [
      JSON.stringify({ schemaVersion: 1, triggerId: input.triggerId }),
      input.workspaceId,
      operation,
      `${input.actorId}:${input.triggerId}`,
      keyHash(input.idempotencyKey),
    ],
  );
}

async function insertSecret(
  client: PoolClient,
  input: Command,
  secretInput: SealedWebhookTriggerSecret,
): Promise<z.output<typeof sealedSchema>> {
  const secret = sealedSchema.parse(secretInput);
  await client.query(
    `insert into app.webhook_trigger_secret_versions
      (id,workspace_id,trigger_id,purpose,schema_version,kms_key_reference,
       encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
     values($1,$2,$3,'webhook_hmac_sha256',$4,$5,$6,$7,$8,$9,$10)`,
    [
      secret.id,
      input.workspaceId,
      input.triggerId,
      secret.schemaVersion,
      secret.kmsKeyReference,
      secret.encryptedDataKey,
      secret.ciphertext,
      secret.nonce,
      secret.authTag,
      input.actorId,
    ],
  );
  return secret;
}

async function oneHealth(
  client: PoolClient,
  workspaceId: string,
  triggerId: string,
): Promise<WorkflowTriggerHealth> {
  const identity = await client.query<{ workflow_id: string }>(
    'select workflow_id from app.workflow_triggers where workspace_id=$1 and id=$2',
    [workspaceId, triggerId],
  );
  const workflowId = identity.rows[0]?.workflow_id;
  if (workflowId === undefined) throw new WebhookTriggerNotFoundError();
  const health = await readHealth(client, workspaceId, workflowId);
  const trigger = health.find(({ id }) => id === triggerId);
  if (trigger === undefined) throw new WebhookTriggerNotFoundError();
  return trigger;
}

function mapSecret(
  row: Record<string, unknown>,
  prefix: 'current' | 'previous',
): SealedWebhookTriggerSecret | undefined {
  if (row[`${prefix}_secret_version_id`] == null) return undefined;
  return Object.freeze({
    id: uuidSchema.parse(row[`${prefix}_secret_version_id`]),
    schemaVersion: z.literal(1).parse(row[`${prefix}_schema_version`]),
    kmsKeyReference: z.string().parse(row[`${prefix}_kms_key_reference`]),
    encryptedDataKey: z.string().parse(row[`${prefix}_encrypted_data_key`]),
    ciphertext: z.string().parse(row[`${prefix}_ciphertext`]),
    nonce: z.string().parse(row[`${prefix}_nonce`]),
    authTag: z.string().parse(row[`${prefix}_auth_tag`]),
  });
}

async function executableProjection(
  transaction: WorkspaceTransaction,
  workflowVersionId: string,
): Promise<PublishedWorkflowV2Projection> {
  const result = await transaction.db.execute(sql<Record<string, unknown>>`
    select id,workspace_id,workflow_id,version_number,schema_version,checksum,
           executable_schema_version,executable_json,compatibility_release_epoch
      from app.workflow_versions where workspace_id=${transaction.workspaceId}
       and id=${workflowVersionId}
  `);
  const classified = classifyPublishedWorkflowVersionRow(result.rows[0]);
  if (classified.kind !== 'v2_projection')
    throw new WebhookDeliveryIneligibleError();
  return classified.workflowVersion;
}

export function createWebhookTriggerDatabase(
  config: DatabaseConfig,
  compatibilityReleaseInput:
    CompatibilityReleaseExpectation | CompatibilityReleaseExpectationSet,
): WebhookTriggerDatabase {
  const pool = new Pool(config);
  const compatibilityReleases = Array.isArray(compatibilityReleaseInput)
    ? parseCompatibilityReleaseExpectationSet(compatibilityReleaseInput)
    : Object.freeze([
        parseCompatibilityReleaseExpectation(compatibilityReleaseInput),
      ]);
  const command = <T>(
    input: Command,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withTenantScopedClient(
      pool,
      {
        workspaceId: uuidSchema.parse(input.workspaceId),
        actorId: uuidSchema.parse(input.actorId),
      },
      work,
    );

  return Object.freeze({
    provision: (input: Parameters<WebhookTriggerDatabase['provision']>[0]) =>
      command(input, async (client) => {
        await authorizeManager(client, input.workspaceId, input.actorId);
        const operation = 'webhook.trigger.provision';
        if (await claimCommand(client, input, operation))
          return oneHealth(client, input.workspaceId, input.triggerId);
        const trigger = await client.query<{ workflow_id: string }>(
          `select workflow_id from app.workflow_triggers where workspace_id=$1 and id=$2
             and kind='webhook' and status='configuration_required' for update`,
          [input.workspaceId, uuidSchema.parse(input.triggerId)],
        );
        if (trigger.rows[0] === undefined)
          throw new WebhookTriggerNotFoundError();
        const secret = await insertSecret(client, input, input.secret);
        await client.query(
          `insert into app.webhook_trigger_endpoints
            (id,workspace_id,trigger_id,endpoint_key_hash,current_secret_version_id)
           values($1,$2,$3,$4,$5)`,
          [
            uuidSchema.parse(input.endpointId),
            input.workspaceId,
            input.triggerId,
            digestSchema.parse(input.endpointKeyHash),
            secret.id,
          ],
        );
        await client.query(
          `update app.workflow_triggers set status='active',health_status='healthy',
             reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2`,
          [input.workspaceId, input.triggerId],
        );
        await refreshWorkflowActivation(
          client,
          input.workspaceId,
          trigger.rows[0].workflow_id,
        );
        await completeCommand(client, input, operation);
        return oneHealth(client, input.workspaceId, input.triggerId);
      }),
    rotateEndpoint: (
      input: Parameters<WebhookTriggerDatabase['rotateEndpoint']>[0],
    ) =>
      command(input, async (client) => {
        await authorizeManager(client, input.workspaceId, input.actorId);
        const operation = 'webhook.trigger.endpoint.rotate';
        if (await claimCommand(client, input, operation))
          return oneHealth(client, input.workspaceId, input.triggerId);
        const result = await client.query(
          `update app.webhook_trigger_endpoints set endpoint_key_hash=$3,updated_at=clock_timestamp()
            where workspace_id=$1 and trigger_id=$2 and status='active'`,
          [
            input.workspaceId,
            input.triggerId,
            digestSchema.parse(input.endpointKeyHash),
          ],
        );
        if (result.rowCount !== 1) throw new WebhookTriggerNotFoundError();
        await completeCommand(client, input, operation);
        return oneHealth(client, input.workspaceId, input.triggerId);
      }),
    rotateSecret: (
      input: Parameters<WebhookTriggerDatabase['rotateSecret']>[0],
    ) =>
      command(input, async (client) => {
        await authorizeManager(client, input.workspaceId, input.actorId);
        const operation = 'webhook.trigger.secret.rotate';
        if (await claimCommand(client, input, operation))
          return oneHealth(client, input.workspaceId, input.triggerId);
        const endpoint = await client.query<{
          current_secret_version_id: string;
        }>(
          `select current_secret_version_id from app.webhook_trigger_endpoints
            where workspace_id=$1 and trigger_id=$2 and status='active' for update`,
          [input.workspaceId, input.triggerId],
        );
        const current = endpoint.rows[0]?.current_secret_version_id;
        if (current === undefined) throw new WebhookTriggerNotFoundError();
        const secret = await insertSecret(client, input, input.secret);
        await client.query(
          `update app.webhook_trigger_endpoints set current_secret_version_id=$3,
             previous_secret_version_id=$4,
             previous_secret_valid_until=clock_timestamp()+interval '5 minutes',
             updated_at=clock_timestamp() where workspace_id=$1 and trigger_id=$2`,
          [input.workspaceId, input.triggerId, secret.id, current],
        );
        await completeCommand(client, input, operation);
        return oneHealth(client, input.workspaceId, input.triggerId);
      }),
    getHealth: (input: Parameters<WebhookTriggerDatabase['getHealth']>[0]) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: uuidSchema.parse(input.workspaceId),
          actorId: uuidSchema.parse(input.actorId),
        },
        async (client) => {
          await authorizeReader(client, input.workspaceId, input.actorId);
          return readHealth(
            client,
            input.workspaceId,
            uuidSchema.parse(input.workflowId),
          );
        },
      ),
    resolveVerification: async (
      endpointKeyHashInput: Parameters<
        WebhookTriggerDatabase['resolveVerification']
      >[0],
    ) => {
      const endpointKeyHash = digestSchema.parse(endpointKeyHashInput);
      const result = await pool.query<Record<string, unknown>>(
        'select * from app.resolve_public_webhook_endpoint($1::char(64))',
        [endpointKeyHash],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const currentSecret = mapSecret(row, 'current');
      if (currentSecret === undefined) return null;
      const previousSecret = mapSecret(row, 'previous');
      return Object.freeze({
        endpointId: uuidSchema.parse(row.endpoint_id),
        endpointKeyHash,
        workspaceId: uuidSchema.parse(row.workspace_id),
        triggerId: uuidSchema.parse(row.trigger_id),
        workflowId: uuidSchema.parse(row.workflow_id),
        workflowVersionId: uuidSchema.parse(row.workflow_version_id),
        nodeId: z.string().parse(row.node_id),
        databaseTime: z.date().parse(row.database_time),
        currentSecret,
        ...(previousSecret === undefined
          ? {}
          : {
              previousSecret: Object.freeze({
                ...previousSecret,
                validUntil: z.date().parse(row.previous_secret_valid_until),
              }),
            }),
      });
    },
    acceptVerifiedDelivery: async (
      input: Parameters<WebhookTriggerDatabase['acceptVerifiedDelivery']>[0],
    ) => {
      const verification = input.verification;
      const requestFingerprint = digestSchema.parse(input.requestFingerprint);
      const dedupeKind =
        input.idempotencyKeyHash === undefined ? 'fingerprint' : 'keyed';
      const dedupeKeyHash = digestSchema.parse(
        input.idempotencyKeyHash ?? requestFingerprint,
      );
      return withWorkspaceTransaction(
        pool,
        uuidSchema.parse(verification.workspaceId),
        async (transaction) => {
          const existing = await transaction.db.execute<{
            request_fingerprint: string;
            workflow_run_id: string | null;
            active: boolean;
          }>(sql`
            select pg_advisory_xact_lock(hashtextextended(
                     ${`${verification.endpointId}:${dedupeKind}:${dedupeKeyHash}`},0)),
                   request_fingerprint,workflow_run_id,
                   expires_at>clock_timestamp() active
              from app.webhook_trigger_replay_records
             where workspace_id=${transaction.workspaceId}
               and endpoint_id=${verification.endpointId}
               and dedupe_kind=${dedupeKind} and dedupe_key_hash=${dedupeKeyHash}
             for update
          `);
          const replay = existing.rows[0];
          if (replay !== undefined && replay.active) {
            if (replay.request_fingerprint !== requestFingerprint)
              throw new WebhookDeliveryReplayMismatchError();
            if (replay.workflow_run_id === null)
              throw new Error('Webhook replay record is incomplete');
            return Object.freeze({
              runId: replay.workflow_run_id,
              replayed: true,
            });
          }
          if (replay !== undefined) {
            await transaction.db.execute(sql`
              delete from app.webhook_trigger_replay_records
               where workspace_id=${transaction.workspaceId}
                 and endpoint_id=${verification.endpointId}
                 and dedupe_kind=${dedupeKind} and dedupe_key_hash=${dedupeKeyHash}
            `);
          }
          if (replay === undefined) {
            await transaction.db.execute(sql`
              select pg_advisory_xact_lock(hashtextextended(
                ${`${verification.endpointId}:${dedupeKind}:${dedupeKeyHash}`},0))
            `);
            const raced = await transaction.db.execute<{
              request_fingerprint: string;
              workflow_run_id: string | null;
              active: boolean;
            }>(sql`
              select request_fingerprint,workflow_run_id,
                     expires_at>clock_timestamp() active
                from app.webhook_trigger_replay_records
               where workspace_id=${transaction.workspaceId}
                 and endpoint_id=${verification.endpointId}
                 and dedupe_kind=${dedupeKind} and dedupe_key_hash=${dedupeKeyHash}
               for update
            `);
            const concurrent = raced.rows[0];
            if (concurrent?.active === true) {
              if (concurrent.request_fingerprint !== requestFingerprint)
                throw new WebhookDeliveryReplayMismatchError();
              if (concurrent.workflow_run_id === null)
                throw new Error('Webhook replay record is incomplete');
              return Object.freeze({
                runId: concurrent.workflow_run_id,
                replayed: true,
              });
            }
          }

          const eligible = await transaction.db.execute<{
            workflow_version_id: string;
          }>(sql`
            select trigger.workflow_version_id
              from app.webhook_trigger_endpoints endpoint
              join app.workflow_triggers trigger on trigger.workspace_id=endpoint.workspace_id
               and trigger.id=endpoint.trigger_id
              join app.workflows workflow on workflow.workspace_id=trigger.workspace_id
               and workflow.id=trigger.workflow_id
              join app.workspaces workspace on workspace.id=trigger.workspace_id
             where endpoint.workspace_id=${transaction.workspaceId}
               and endpoint.id=${verification.endpointId}
               and endpoint.endpoint_key_hash=${verification.endpointKeyHash}
               and endpoint.trigger_id=${verification.triggerId}
               and endpoint.status='active' and trigger.status='active'
               and trigger.workflow_id=${verification.workflowId}
               and trigger.workflow_version_id=${verification.workflowVersionId}
               and workflow.published_version_id=trigger.workflow_version_id
               and workflow.lifecycle_status='active'
               and workflow.activation_status in ('active','degraded')
               and workspace.status='active'
               and (endpoint.current_secret_version_id=${input.verifiedSecretVersionId}
                 or (endpoint.previous_secret_version_id=${input.verifiedSecretVersionId}
                   and endpoint.previous_secret_valid_until>clock_timestamp()))
             for share of endpoint,trigger,workflow,workspace
          `);
          if (eligible.rows[0] === undefined)
            throw new WebhookDeliveryIneligibleError();

          const deliveryId = randomUUID();
          await transaction.db.execute(sql`
            insert into app.webhook_trigger_replay_records
              (workspace_id,endpoint_id,dedupe_kind,dedupe_key_hash,
               request_fingerprint,delivery_id,expires_at)
            values(${transaction.workspaceId},${verification.endpointId},${dedupeKind},
              ${dedupeKeyHash},${requestFingerprint},${deliveryId},
              clock_timestamp()+case when ${dedupeKind}='keyed'
                then interval '24 hours' else interval '5 minutes' end)
          `);
          const currentCompatibilityRelease =
            await lockExpectedCompatibilityReleaseSet(
              transaction.db,
              compatibilityReleases,
            );
          const projection = await executableProjection(
            transaction,
            verification.workflowVersionId,
          );
          const initial = input.checkpointFactory(
            projection,
            currentCompatibilityRelease,
          );
          const accepted = await acceptWorkflowRun(transaction, {
            engineVersion: initial.engineVersion,
            initialCheckpoint: initial.checkpoint,
            keyHash: createHash('sha256').update(deliveryId).digest('hex'),
            operation: 'workflow.run.accept',
            requestHash: requestFingerprint,
            scope: `webhook:${verification.endpointId}`,
            triggerType: 'webhook',
            workflowId: verification.workflowId,
            workflowVersionId: verification.workflowVersionId,
            runInput: input.payload,
            ...(input.traceparent === undefined
              ? {}
              : { traceparent: input.traceparent }),
          });
          await transaction.db.execute(sql`
            insert into app.webhook_trigger_deliveries
              (id,workspace_id,trigger_id,endpoint_id,workflow_run_id,dedupe_kind)
            values(${deliveryId},${transaction.workspaceId},${verification.triggerId},
              ${verification.endpointId},${accepted.runId},${dedupeKind})
          `);
          await transaction.db.execute(sql`
            update app.webhook_trigger_replay_records set workflow_run_id=${accepted.runId}
             where workspace_id=${transaction.workspaceId} and delivery_id=${deliveryId}
          `);
          return Object.freeze({ runId: accepted.runId, replayed: false });
        },
      );
    },
    close: () => pool.end(),
  });
}
