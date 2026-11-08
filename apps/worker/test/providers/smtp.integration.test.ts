import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store/server';
import type { NodeArtifactReference } from '@pertexo/node-sdk/server';
import { createWorkerNodeRuntimeCapabilities } from '../../src/attempts/execution/runtime-capabilities.js';
import { createTestArtifactScratch } from '../support/infrastructure/artifact-scratch.js';
import { JOB_NAME } from '@pertexo/queue/server';
import { createSmtpEmailClient } from '../../src/providers/smtp-email.js';
import { createFailureNotificationHandler } from '../../src/notifications/failure-handler.js';
import { createProviderFailureNotificationDelivery } from '../../src/notifications/failure-delivery.js';
import {
  acceptRun,
  terminalizeFailedRun,
} from '../support/coordinator/runs.js';
import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createConnectionStore } from '@pertexo/core/connections';
import {
  createFailureNotificationStore,
  createNotificationDestinationStore,
} from '@pertexo/core/notifications';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  createConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
} from '@pertexo/secrets/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit/server';
import { createPlatformNodeRegistry } from '../../src/providers/node-registry.js';
import { createProviderConnectionRuntimeFactory } from '../../src/providers/connections.js';
import { coordinatorFixture as fixture } from '../support/coordinator/consumer.js';

const encryption = createConnectionEnvelopeEncryption({
  mode: 'self-managed',
  encryption: {
    previous: [],
    current: {
      version: 'smtp-test',
      key: Buffer.alloc(32, 7).toString('base64'),
    },
  },
});
const config = () =>
  parseDatabaseConfig({
    connectionString: fixture.databaseUrl(fixture.apiUrl),
    max: 3,
  });
let connections: ReturnType<typeof createConnectionStore>;
let destinations: ReturnType<typeof createNotificationDestinationStore>;
let limiter: RedisRateLimitRuntime;
let port = 0;
const messages: string[] = [];
const relay = new SMTPServer({
  logger: false,
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  onAuth: (_auth, _session, callback) => {
    callback(null, { user: 'ada' });
  },
  onData: (stream, _session, callback) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      messages.push(Buffer.concat(chunks).toString());
      callback();
    });
  },
});

describe.runIf(fixture.enabled)(
  'SMTP email steps with stored connections',
  () => {
    beforeAll(async () => {
      await fixture.setup();
      connections = createConnectionStore(config());
      destinations = createNotificationDestinationStore(config());
      limiter = new RedisRateLimitRuntime(fixture.redisUrl);
      await new Promise<void>((resolve) =>
        relay.listen(0, '127.0.0.1', resolve),
      );
      const address = relay.server.address();
      if (!address || typeof address === 'string')
        throw new Error('SMTP relay did not start');
      port = address.port;
    }, 60_000);
    afterAll(async () => {
      await Promise.allSettled([
        connections.close(),
        destinations.close(),
        limiter.close(),
        new Promise<void>((resolve) => {
          relay.close(resolve);
        }),
      ]);
      encryption.close();
      await fixture.restoreServicesAndClose();
    });
    it('delivers the configured sender, recipient and message, and refuses to repeat an uncertain send', async () => {
      const connectionId = randomUUID(),
        secretVersionId = randomUUID();
      const password = 'smtp-secret-never-in-a-receipt';
      const credential = {
        type: 'smtp',
        host: '127.0.0.1',
        port,
        security: 'none',
        username: 'ada',
        password,
        fromEmail: 'alerts@example.test',
        fromName: 'Workspace alerts',
      };
      const sealed = await encryption.encryption.seal(
        new TextEncoder().encode(JSON.stringify(credential)),
        { workspaceId: fixture.workspaceId, connectionId, secretVersionId },
        new AbortController().signal,
      );
      await connections.createConnection({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        connectionId,
        secretVersionId,
        providerKey: 'email',
        name: 'SMTP relay',
        authType: 'smtp',
        sealed,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
      });
      const context = {
        workspaceId: fixture.workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'mail',
        invocationKey: 'root:mail',
        workerId: 'smtp-proof',
      };
      const runtime = {
        ...context,
        sideEffectClass: 'idempotent_with_key' as const,
        providerIdempotencyKey: 'smtp-send-proof',
        beforeDispatch: () => Promise.resolve(),
        connections: createProviderConnectionRuntimeFactory(
          connections,
          encryption.encryption,
          limiter,
        )(context),
      };
      const registry = createPlatformNodeRegistry(
        {},
        {
          allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
          allowPlaintext: true,
        },
      );
      const invocation = {
        definition: { key: 'email.send_notification', version: 1 },
        executor: { key: 'email.send_notification', version: 1 },
        config: { timeoutMillis: 2000 },
        input: {
          toEmail: 'member@example.test',
          subject: 'Workflow failed',
          text: 'Inspect the failed run.',
        },
        connectionRefs: { resend_api_key: connectionId },
        runtime,
        signal: new AbortController().signal,
      };
      const result = await registry.execute(invocation);
      expect(result.kind).toBe('succeeded');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        'From: Workspace alerts <alerts@example.test>',
      );
      expect(messages[0]).toContain('To: member@example.test');
      expect(messages[0]).toContain('Subject: Workflow failed');
      expect(messages[0]).toContain('Inspect the failed run.');
      expect(JSON.stringify(result)).not.toContain(password);
      await expect(
        registry.execute({
          ...invocation,
          runtime: { ...runtime, providerDispatchUnresolved: true },
        }),
      ).rejects.toMatchObject({
        kind: 'outcome_unknown',
        possiblyDispatched: true,
      });
      expect(messages).toHaveLength(1);
      const destinationId = randomUUID();
      expect(
        (
          await destinations.create({
            workspaceId: fixture.workspaceId,
            actorId: fixture.actorId,
            destinationId,
            config: {
              kind: 'email',
              connectionId,
              toEmail: 'member@example.test',
            },
            idempotencyKey: randomUUID(),
            requestHash: 'b'.repeat(64),
          })
        ).config,
      ).toMatchObject({ connectionId });
      const stored = await fixture.ownerQuery(
        'select side_effect_class from app.failure_notification_destination_versions where destination_id=$1',
        [destinationId],
      );
      expect(stored[0]).toMatchObject({ side_effect_class: 'unsafe' });
      await destinations.setWorkflowPolicy({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        workflowId: fixture.workflowId,
        destinationId,
        idempotencyKey: randomUUID(),
        requestHash: 'c'.repeat(64),
      });
      const { intentId } = await terminalizeFailedRun(await acceptRun());
      const store = createFailureNotificationStore(config());
      try {
        const handler = createFailureNotificationHandler({
          store,
          timeoutMillis: 5000,
          maxAttempts: 2,
          retryDelaySeconds: 1,
          delivery: createProviderFailureNotificationDelivery({
            store,
            encryption: encryption.encryption,
            workerId: 'smtp-alert-proof',
            publicWebOrigin: 'https://app.example.test',
            smtp: createSmtpEmailClient({
              allowedPrivateNetworks:
                parseAllowedPrivateNetworks('127.0.0.1/32'),
              allowPlaintext: true,
            }),
            slack: {
              sendMessage: () =>
                Promise.reject(new Error('No Slack request permitted')),
            },
            email: {
              sendNotification: () =>
                Promise.reject(new Error('No Resend request permitted')),
            },
          }),
        });
        const [outbox] = await fixture.workerQuery<{
          payload: Parameters<typeof handler.handle>[0]['data'];
        }>(
          "select payload from app.outbox_events where aggregate_id=$1 and job_name='deliver-run-failure-notification' order by created_at desc,id desc limit 1",
          [intentId],
        );
        if (outbox === undefined)
          throw new Error('Missing failure alert delivery job');
        await handler.handle(
          {
            name: JOB_NAME.deliverRunFailureNotification,
            data: outbox.payload,
            transport: {
              attemptsMade: 0,
              jobId: `outbox-${outbox.payload.outboxEventId}`,
            },
          },
          { signal: new AbortController().signal },
        );
        const [intent] = await fixture.workerQuery(
          'select status,side_effect_class from app.run_failure_notification_intents where id=$1',
          [intentId],
        );
        expect(intent).toMatchObject({
          status: 'delivered',
          side_effect_class: 'unsafe',
        });
        expect(messages).toHaveLength(2);
        expect(messages[1]).toContain(
          'From: Workspace alerts <alerts@example.test>',
        );
        expect(messages[1]).toContain('To: member@example.test');
        expect(messages[1]).not.toContain(password);
      } finally {
        await store.close();
      }
    });
    it.runIf(process.env.ARTIFACT_STORE_INTEGRATION === 'true')(
      'delivers a verified stored file through SMTP',
      async () => {
        const scratch = await createTestArtifactScratch();
        const objectConfig = parseArtifactStoreConfig(process.env);
        const objects = createArtifactStore(objectConfig);
        const artifactId = randomUUID();
        const capabilities = await createWorkerNodeRuntimeCapabilities(
          {
            database: config(),
            artifactScratchDirectory: scratch.directory,
            artifactStore: objectConfig,
          },
          { artifactId: () => artifactId },
        );
        let created = false;
        try {
          const context = {
            workspaceId: fixture.workspaceId,
            runId: randomUUID(),
            nodeRunId: randomUUID(),
            attemptId: randomUUID(),
            attemptNumber: 1,
            nodeId: 'report',
            invocationKey: 'root:report',
            workerId: 'smtp-attachment-proof',
            artifactRetentionDeadline: new Date(Date.now() + 600_000),
          };
          const artifacts = capabilities.factories.artifacts?.(context);
          if (artifacts === undefined)
            throw new Error('Artifact runtime is unavailable');
          const signal = new AbortController().signal;
          const registry = createPlatformNodeRegistry(
            {},
            {
              allowedPrivateNetworks:
                parseAllowedPrivateNetworks('127.0.0.1/32'),
              allowPlaintext: true,
            },
          );
          const fileResult = await registry.execute({
            definition: { key: 'core.create_file', version: 1 },
            executor: { key: 'core.create_file', version: 1 },
            config: { format: 'csv', delimiter: ',', columns: ['week'] },
            input: { data: [{ week: 42 }] },
            runtime: {
              ...context,
              artifacts,
              sideEffectClass: 'safe',
              beforeDispatch: () => Promise.resolve(),
            },
            signal,
          });
          expect(fileResult.kind).toBe('succeeded');
          if (fileResult.kind !== 'succeeded')
            throw new Error('Create file failed');
          created = true;
          const file = (
            fileResult.output as {
              file: NodeArtifactReference & { kind: 'artifact' };
            }
          ).file;
          const connectionId = randomUUID(),
            secretVersionId = randomUUID();
          const credential = {
            type: 'smtp',
            host: '127.0.0.1',
            port,
            security: 'none',
            username: 'ada',
            password: 'private-attachment-password',
            fromEmail: 'reports@example.test',
          };
          const sealed = await encryption.encryption.seal(
            new TextEncoder().encode(JSON.stringify(credential)),
            { workspaceId: fixture.workspaceId, connectionId, secretVersionId },
            signal,
          );
          await connections.createConnection({
            workspaceId: fixture.workspaceId,
            actorId: fixture.actorId,
            connectionId,
            secretVersionId,
            providerKey: 'email',
            name: 'SMTP file relay',
            authType: 'smtp',
            sealed,
            idempotencyKey: randomUUID(),
            requestHash: 'd'.repeat(64),
          });
          const count = messages.length;
          const result = await registry.execute({
            definition: { key: 'email.send_notification', version: 1 },
            executor: { key: 'email.send_notification', version: 1 },
            config: { timeoutMillis: 2000 },
            input: {
              toEmail: 'member@example.test',
              subject: 'Weekly report',
              text: 'The report is attached.',
              attachments: [{ file, filename: 'report.csv' }],
            },
            connectionRefs: { resend_api_key: connectionId },
            runtime: {
              ...context,
              artifacts,
              sideEffectClass: 'idempotent_with_key',
              providerIdempotencyKey: 'smtp-file-proof',
              beforeDispatch: () => Promise.resolve(),
              connections: createProviderConnectionRuntimeFactory(
                connections,
                encryption.encryption,
                limiter,
              )(context),
            },
            signal,
          });
          expect(result.kind).toBe('succeeded');
          expect(messages).toHaveLength(count + 1);
          expect(messages[count]).toContain('filename=report.csv');
          expect(messages[count]).toContain(
            Buffer.from('"week"\r\n"42"\r\n').toString('base64'),
          );
          expect(JSON.stringify(result)).not.toContain(
            'private-attachment-password',
          );
        } finally {
          if (created)
            await objects.delete({
              artifactId,
              workspaceId: fixture.workspaceId,
            });
          await capabilities.close();
          objects.close();
          await scratch.close();
        }
      },
    );
  },
);
