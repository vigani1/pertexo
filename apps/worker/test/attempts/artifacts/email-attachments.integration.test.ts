import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  createResendClient,
  type SecureHttpRequest,
} from '@pertexo/integrations/server';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import type {
  NodeArtifactReference,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import { createArtifactDatabaseEnvironment } from './database.js';

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const emailId = '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2';

type DeliveredAttachment = Readonly<{
  filename: string;
  content_type: string;
  content: string;
}>;

/** Stands in for Resend: keeps each request body and accepts it. */
function createResendDouble() {
  const bodies: Buffer[] = [];
  const execute = vi.fn(async (request: SecureHttpRequest) => {
    const body = request.body;
    if (body === undefined || body instanceof Uint8Array)
      throw new Error('Attachments travel as a spooled file-backed body');
    const chunks: Buffer[] = [];
    for await (const chunk of body.open(new AbortController().signal))
      chunks.push(Buffer.from(chunk as Uint8Array));
    bodies.push(Buffer.concat(chunks));
    await request.beforeDispatch();
    return {
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ id: emailId })),
      bodyEncoding: 'utf8' as const,
      finalUrl: request.url,
      redirectCount: 0,
    };
  });
  return { execute, bodies };
}

(integration ? describe : describe.skip)(
  'Send email attachments with real worker storage',
  () => {
    it('reads a created CSV through the artifact runtime and posts it to Resend', async () => {
      const environment = createArtifactDatabaseEnvironment();
      const config = parseArtifactStoreConfig(process.env);
      const artifactId = randomUUID(),
        workspaceId = randomUUID(),
        connectionId = randomUUID();
      const context = {
        workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'report',
        invocationKey: 'root:report',
        workerId: 'email-attachments-qualification',
        artifactRetentionDeadline: new Date(Date.now() + 600_000),
      };
      let capabilities:
        | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
        | undefined;
      let store: ReturnType<typeof createArtifactStore> | undefined;
      await runWithCleanup(
        async () => {
          await environment.initialize();
          capabilities = await createWorkerNodeRuntimeCapabilities(
            {
              database: environment.workerConfig,
              artifactScratchDirectory: environment.artifactScratchDirectory,
              artifactStore: config,
            },
            { artifactId: () => artifactId },
          );
          store = createArtifactStore(config);
          const artifacts = capabilities.factories.artifacts?.(context);
          if (artifacts?.openVerified === undefined)
            throw new Error('Missing file capabilities');
          const signal = new AbortController().signal;
          const identity = (key: string) => ({ key, version: 1 });
          const resend = createResendDouble();
          const registry = createPlatformNodeRegistry({
            emailSendNotification: {
              client: createResendClient({ execute: resend.execute }),
            },
          });
          const created = await registry.execute({
            definition: identity('core.create_file'),
            executor: identity('core.create_file'),
            config: { format: 'csv', delimiter: ',', columns: ['week'] },
            input: { data: [{ week: 42 }, { week: 43 }] },
            runtime: {
              ...context,
              artifacts,
              sideEffectClass: 'safe',
              beforeDispatch: () => Promise.resolve(),
            },
            signal,
          });
          if (created.kind !== 'succeeded')
            throw new Error('Create file did not succeed');
          const file = (
            created.output as {
              file: NodeArtifactReference & { kind: 'artifact' };
            }
          ).file;
          const expected = Buffer.from('"week"\r\n"42"\r\n"43"\r\n');
          expect(file.sha256).toBe(
            createHash('sha256').update(expected).digest('hex'),
          );
          const beforeDispatch = vi.fn(() => Promise.resolve());
          const emailRuntime = (
            files: NodeExecutionRuntime['artifacts'],
          ): NodeExecutionRuntime => ({
            ...context,
            nodeId: 'email',
            invocationKey: 'root:email',
            ...(files === undefined ? {} : { artifacts: files }),
            sideEffectClass: 'idempotent_with_key',
            providerIdempotencyKey: 'v1.email-attachments',
            beforeDispatch,
            connections: {
              resolve: () =>
                Promise.resolve({
                  connectionId,
                  providerKey: 'email',
                  authType: 'resend_api_key',
                  secretVersionId: randomUUID(),
                  secret: new TextEncoder().encode(
                    JSON.stringify({
                      type: 'resend_api_key',
                      apiKey: 're_qualification_key',
                      fromEmail: 'reports@example.com',
                    }),
                  ),
                }),
              assertCurrent: () => Promise.resolve(),
            },
          });
          const request = {
            definition: identity('email.send_notification'),
            executor: identity('email.send_notification'),
            config: { timeoutMillis: 5_000 },
            input: {
              toEmail: 'owner@example.com',
              subject: 'Weekly report',
              text: 'The weekly report is attached.',
              attachments: [{ file, filename: 'weekly-report.csv' }],
            },
            connectionRefs: { resend_api_key: connectionId },
            signal,
          };
          await expect(
            registry.execute({ ...request, runtime: emailRuntime(artifacts) }),
          ).resolves.toEqual({
            kind: 'succeeded',
            output: {
              emailId,
              attachments: [
                {
                  filename: 'weekly-report.csv',
                  mediaType: file.mediaType,
                  byteLength: expected.length,
                },
              ],
            },
          });
          expect(beforeDispatch).toHaveBeenCalledOnce();
          const delivered = JSON.parse(
            resend.bodies[0]?.toString('utf8') ?? '{}',
          ) as { attachments: DeliveredAttachment[] };
          expect(delivered.attachments).toHaveLength(1);
          expect(delivered.attachments[0]).toMatchObject({
            filename: 'weekly-report.csv',
            content_type: file.mediaType,
          });
          expect(
            Buffer.from(
              delivered.attachments[0]?.content ?? '',
              'base64',
            ).equals(expected),
          ).toBe(true);

          // The same reference from another workspace is not readable.
          const foreign = capabilities.factories.artifacts?.({
            ...context,
            workspaceId: randomUUID(),
          });
          await expect(
            registry.execute({ ...request, runtime: emailRuntime(foreign) }),
          ).rejects.toMatchObject({
            kind: 'failed',
            safeErrorCode: 'execution.file_input',
            possiblyDispatched: false,
          });
          expect(resend.execute).toHaveBeenCalledOnce();
        },
        async () => {
          const failures: unknown[] = [];
          const clean = async (operation: () => Promise<unknown>) => {
            try {
              await operation();
            } catch (error) {
              failures.push(error);
            }
          };
          await clean(
            () =>
              store?.delete({ artifactId, workspaceId }) ?? Promise.resolve(),
          );
          await clean(() => store?.close() ?? Promise.resolve());
          await clean(() => capabilities?.close() ?? Promise.resolve());
          await clean(() => environment.close());
          if (failures.length > 0)
            throw new AggregateError(
              failures,
              'Email attachment qualification cleanup failed',
            );
        },
        'Email attachment qualification',
      );
    }, 30_000);
  },
);
