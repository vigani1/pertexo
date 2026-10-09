import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import {
  createWorkspaceInvitationDeliveryStore,
  type WorkspaceInvitationDeliveryStore,
} from '@pertexo/database/tenant-access';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  createApplicationSecretEnvelope,
  type ApplicationSecretEnvelope,
  type ResendClient,
} from '@pertexo/integrations/server';
import {
  parseQueueJob,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import { invitationKeys } from './support/better-auth-real-api.integration.support.js';
import { FixtureResourceOwner } from './support/fixture-resource-owner.js';
import { ownEditorBrowserProcess } from './support/editor-browser-process.js';
import {
  assertOrganizationPreviewPortVacant,
  closeOrganizationBrowserBarriers,
  waitForOwnedOrganizationPreview,
} from './support/workflow-organization-browser-lifetime.js';
import { useOrganizationOwnedApi } from './support/workflow-organization-owned-api.fixture.js';

const enabled =
  process.env.F07_ORGANIZATION_BROWSER_INTEGRATION === 'true' &&
  process.env.F07_ORGANIZATION_OWNED_FIXTURE === 'true';
const webOrigin = 'http://127.0.0.1:4174';
const webDirectory = new URL('../../web/', import.meta.url);
const webRequire = createRequire(new URL('package.json', webDirectory));
const evidenceSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowIds: z.array(z.uuid()).length(2),
    folderId: z.uuid(),
    tagId: z.uuid(),
  })
  .strict();

const matrixSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowIds: z.array(z.uuid()).length(2),
    role: z.enum(['viewer', 'builder', 'admin']),
    partialStatuses: z.tuple([z.literal('updated'), z.literal('conflict')]),
    privateReadIsolation: z.literal(true),
    privateWriteIsolation: z.boolean(),
    archivedMove: z.literal(true),
    archivedTagCleanup: z.literal(true),
    restored: z.literal(true),
    roleEditingBoundary: z.literal(true),
  })
  .strict();
const defaultOffSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    folderId: z.uuid(),
    tagId: z.uuid(),
    metadataRetained: z.literal(true),
    metadataReads: z.literal(0),
    organizationControls: z.literal(false),
  })
  .strict();
describe
  .skipIf(!enabled)
  .each(['viewer', 'builder', 'admin', 'default-off'] as const)(
  'owned F07 ordinary browser and real organization API — %s',
  (role) => {
    const owner = new FixtureResourceOwner();
    const openBrowsers = new Set<string>();
    const barriers: ReturnType<typeof ownEditorBrowserProcess>[] = [];
    const pending = new Set<Promise<void>>();
    let opened = false;
    let observed = false;
    let closing = false;
    let browserPhase = 'startup';
    let failureLine = 0;
    let identityFailure = 'unknown';
    let publicEvidence: unknown;
    const testResults: {
      case: 'owner' | 'default-off';
      status: 'passed' | 'failed';
    }[] = [];
    const { api } = useOrganizationOwnedApi(`organization_browser_${role}`, {
      publicWebOrigin: webOrigin,
      beforeClose: async () => {
        closing = true;
        await Promise.allSettled([...pending]);
        // A failed descendant barrier stops cleanup before the aggregate owner
        // can release the control listener. The API fixture preserves its DB.
        await closeOrganizationBrowserBarriers(barriers);
        await owner.close();
        if (publicEvidence !== undefined)
          await writeFile(
            `/tmp/pertexo-workflow-organization-${role}.public.json`,
            JSON.stringify(
              {
                case: role,
                evidence: publicEvidence,
                selectedTestResults: testResults,
                lifetime: {
                  browserOpenedReceipt: opened,
                  browserDisposedReceipts: openBrowsers.size === 0,
                  ownedProcessBarriersClosed: true,
                  databaseCleanup: 'fixture continues after this receipt',
                },
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
      },
    });
    function ownChild(child: ChildProcess, kind: 'vite' | 'browser') {
      const barrier = ownEditorBrowserProcess(child, kind, {
        browserDisposed: () => opened && openBrowsers.size === 0,
      });
      barriers.push(barrier);
      return owner.acquire(kind, child, () => barrier.close());
    }
    function successfulExit(child: ChildProcess, phase: string) {
      return new Promise<void>((resolve, reject) => {
        child.once('error', () => {
          reject(new Error(`Owned F07 ${phase} startup failed`));
        });
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Owned F07 ${phase} exited unsuccessfully at ${browserPhase} line ${String(failureLine)} identity ${identityFailure}`,
              ),
            );
        });
      });
    }
    it('qualifies ordinary owner management, filters, private favorite and exact bounded recovery', async () => {
      // Compose the compiled production invitation handler and worker-scoped
      // store; only the external mail provider is captured locally. No token
      // is synthesized or decrypted outside the delivery handler.
      const workerBase = process.env.DATABASE_URL;
      if (workerBase === undefined)
        throw new Error('Explicit owned worker database authority required');
      const databaseName = (
        await api
          .database()
          .query<{ name: string }>('select current_database() name')
      ).rows[0]?.name;
      if (databaseName === undefined)
        throw new Error('Owned invitation database unavailable');
      const workerUrl = new URL(workerBase);
      workerUrl.pathname = `/${databaseName}`;
      const deliveryStore = createWorkspaceInvitationDeliveryStore(
        parseDatabaseConfig({ connectionString: workerUrl.toString(), max: 1 }),
      );
      owner.acquire('invitation delivery store', deliveryStore, () =>
        deliveryStore.close(),
      );
      const deliveredMail = new Map<string, string>();
      owner.acquire('captured invitation mail', deliveredMail, () => {
        deliveredMail.clear();
      });
      // Lazy-load the compiled handler only in the enabled lane. API-only
      // discovery does not require the worker's compiled output to exist.
      type DeliveryFactory = (
        dependencies: Readonly<{
          store: WorkspaceInvitationDeliveryStore;
          envelope: Pick<ApplicationSecretEnvelope, 'open'>;
          email: Pick<ResendClient, 'sendNotification'>;
          apiKey: string;
          fromEmail: string;
          webOrigin: string;
          timeoutMillis: number;
        }>,
      ) => Readonly<{
        handle(
          delivery: Extract<
            QueueDelivery,
            { name: 'deliver-workspace-invitation' }
          >,
          context: QueueHandlerContext,
        ): Promise<void>;
      }>;
      const compiled: unknown = await import(
        new URL(
          '../../worker/dist/identity/invitation-delivery.js',
          import.meta.url,
        ).href
      );
      if (
        typeof compiled !== 'object' ||
        compiled === null ||
        !('createWorkspaceInvitationDeliveryHandler' in compiled) ||
        typeof compiled.createWorkspaceInvitationDeliveryHandler !== 'function'
      )
        throw new Error('Compiled canonical invitation handler unavailable');
      const deliveryFactory =
        compiled.createWorkspaceInvitationDeliveryHandler as DeliveryFactory;
      const deliveryHandler = deliveryFactory({
        store: deliveryStore,
        envelope: createApplicationSecretEnvelope(invitationKeys),
        email: {
          sendNotification: async (input) => {
            await input.beforeDispatch();
            const link = input.text
              .split('\n')
              .find((line) =>
                line.startsWith(`${webOrigin}/invitations/accept#token=`),
              );
            if (link === undefined)
              throw new Error('Canonical invitation mail link unavailable');
            deliveredMail.set(input.toEmail, link);
            return { kind: 'succeeded', emailId: crypto.randomUUID() };
          },
        },
        apiKey: 'owned-local-capture',
        fromEmail: 'invites@integration.test',
        webOrigin,
        timeoutMillis: 5000,
      });
      async function deliverInvitation(value: unknown) {
        const { workspaceId, invitationId } = z
          .object({ workspaceId: z.uuid(), invitationId: z.uuid() })
          .strict()
          .parse(value);
        const event = (
          await api
            .database()
            .query<{ id: string; payload: unknown; recipient_email: string }>(
              "select event.id,event.payload,invitation.recipient_email from app.outbox_events event join app.workspace_invitations invitation on invitation.workspace_id=event.workspace_id and invitation.id=event.aggregate_id where event.workspace_id=$1 and event.aggregate_id=$2 and event.job_name='deliver-workspace-invitation' order by event.created_at desc limit 1",
              [workspaceId, invitationId],
            )
        ).rows[0];
        if (event === undefined)
          throw new Error('Canonical invitation outbox event unavailable');
        const job = parseQueueJob({
          name: 'deliver-workspace-invitation',
          data: event.payload,
        });
        if (job.name !== 'deliver-workspace-invitation')
          throw new Error('Canonical invitation job mismatch');
        await deliveryHandler.handle(
          {
            ...job,
            transport: { attemptsMade: 0, jobId: `outbox-${event.id}` },
          },
          { signal: new AbortController().signal },
        );
        const link = deliveredMail.get(event.recipient_email);
        if (link === undefined)
          throw new Error('Canonical invitation was not delivered');
        deliveredMail.delete(event.recipient_email);
        const url = new URL(link);
        return { path: url.pathname + url.hash };
      }
      async function verifyEvidence(value: unknown) {
        const evidence = evidenceSchema.parse(value);
        const rows = await api.database().query<{
          workflow_id: string;
          folder_id: string | null;
          revision: string;
        }>('select workflow_id,folder_id,revision from app.workflow_organization_state where workspace_id=$1 and workflow_id=any($2::uuid[]) order by workflow_id', [evidence.workspaceId, evidence.workflowIds]);
        expect(rows.rows).toHaveLength(2);
        expect(
          rows.rows.every((row) => row.folder_id === evidence.folderId),
        ).toBe(true);
        const folder = await api
          .database()
          .query<{ name: string; parent_id: string | null; revision: string }>(
            'select name,parent_id,revision from app.workflow_folders where workspace_id=$1 and id=$2',
            [evidence.workspaceId, evidence.folderId],
          );
        expect(folder.rows[0]).toMatchObject({
          name: 'Delivery',
          parent_id: null,
        });
        expect(Number(folder.rows[0]?.revision)).toBeGreaterThanOrEqual(3);
        const tags = await api
          .database()
          .query<{ count: number }>(
            'select count(*)::int count from app.workflow_tag_assignments where workspace_id=$1 and tag_id=$2',
            [evidence.workspaceId, evidence.tagId],
          );
        expect(tags.rows[0]?.count).toBe(0);
        const favorites = await api
          .database()
          .query<{ count: number }>(
            'select count(*)::int count from app.workflow_favorites where workspace_id=$1 and workflow_id=$2',
            [evidence.workspaceId, evidence.workflowIds[0]],
          );
        expect(favorites.rows[0]?.count).toBe(1);
        const receipt = await api
          .database()
          .query<{ count: number }>(
            "select count(*)::int count from app.idempotency_records where workspace_id=$1 and operation='organization.batch' and status='completed'",
            [evidence.workspaceId],
          );
        expect(receipt.rows[0]?.count).toBeGreaterThanOrEqual(2);
        observed = true;
      }
      const control = createServer((request, response) => {
        response.setHeader('cache-control', 'no-store');
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (
          closing &&
          !['/browser-opened', '/browser-disposed'].includes(url.pathname)
        ) {
          response.writeHead(503).end();
          return;
        }
        if (request.method === 'GET' && url.pathname === '/verification') {
          try {
            const link = api.mailedLink(
              url.searchParams.get('email') ?? '',
              'verification',
            );
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ path: link.pathname + link.search }));
          } catch {
            response.writeHead(404).end();
          }
          return;
        }
        if (
          request.method !== 'POST' ||
          ![
            '/browser-opened',
            '/browser-disposed',
            '/organization-evidence',
            '/organization-phase',
            '/organization-failure',
            '/invitation-delivery',
            '/organization-matrix',
            '/organization-test-result',
            '/organization-default-off',
          ].includes(url.pathname)
        ) {
          response.writeHead(404).end();
          return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 2048) request.destroy();
        });
        request.on('end', () => {
          const command = Promise.resolve()
            .then(async () => {
              const value: unknown = JSON.parse(body);
              if (url.pathname === '/invitation-delivery') {
                const delivered = await deliverInvitation(value);
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify(delivered));
                return;
              }
              if (url.pathname === '/organization-failure') {
                const diagnostic = z
                  .object({
                    line: z.number().int().min(0).max(10000),
                    identityStatus: z.number().int().min(0).max(599),
                    identityStage: z.enum([
                      '/sign-up',
                      '/login',
                      '/verify-email',
                      '/workspaces',
                      'other',
                    ]),
                  })
                  .strict()
                  .parse(value);
                failureLine = diagnostic.line;
                identityFailure = `${diagnostic.identityStage}:${String(diagnostic.identityStatus)}`;
              } else if (url.pathname === '/organization-matrix') {
                const evidence = matrixSchema.parse(value);
                expect(evidence.role).toBe(role);
                expect(evidence.privateWriteIsolation).toBe(role === 'viewer');
                const members = await api
                  .database()
                  .query<{ role: string }>(
                    "select role::text role from app.workspace_memberships where workspace_id=$1 and status='active'",
                    [evidence.workspaceId],
                  );
                expect(
                  members.rows.map((member) => member.role).sort(),
                ).toEqual(['owner', role].sort());
                const workflows = await api
                  .database()
                  .query<{ id: string; lifecycle_status: string }>(
                    'select id,lifecycle_status from app.workflows where workspace_id=$1 and id=any($2::uuid[])',
                    [evidence.workspaceId, evidence.workflowIds],
                  );
                expect(workflows.rows).toHaveLength(2);
                expect(
                  workflows.rows.every(
                    (workflow) => workflow.lifecycle_status === 'active',
                  ),
                ).toBe(true);
                const tags = await api
                  .database()
                  .query<{ count: number }>(
                    'select count(*)::int count from app.workflow_tag_assignments where workspace_id=$1',
                    [evidence.workspaceId],
                  );
                expect(tags.rows[0]?.count).toBe(0);
                publicEvidence = evidence;
              } else if (url.pathname === '/organization-default-off') {
                const evidence = defaultOffSchema.parse(value);
                expect(role).toBe('default-off');
                const workflows = await api
                  .database()
                  .query<{ count: number }>(
                    'select count(*)::int count from app.workflows where workspace_id=$1 and id=$2',
                    [evidence.workspaceId, evidence.workflowId],
                  );
                expect(workflows.rows[0]?.count).toBe(1);
                const retained = await api.database().query<{ count: number }>(
                  `select count(*)::int count from app.workflows w
                   where w.workspace_id=$1 and w.id=$2
                   and exists (select 1 from app.workflow_organization_state s where s.workspace_id=w.workspace_id and s.workflow_id=w.id and s.folder_id=$3)
                   and exists (select 1 from app.workflow_tag_assignments t where t.workspace_id=w.workspace_id and t.workflow_id=w.id and t.tag_id=$4)
                   and exists (select 1 from app.workflow_favorites f where f.workspace_id=w.workspace_id and f.workflow_id=w.id)`,
                  [
                    evidence.workspaceId,
                    evidence.workflowId,
                    evidence.folderId,
                    evidence.tagId,
                  ],
                );
                expect(retained.rows[0]?.count).toBe(1);
                publicEvidence = evidence;
                observed = true;
              } else if (url.pathname === '/organization-test-result') {
                const result = z
                  .object({
                    case: z.enum(['owner', 'default-off']),
                    status: z.enum(['passed', 'failed']),
                  })
                  .strict()
                  .parse(value);
                if (testResults.length !== 0)
                  throw new Error('Duplicate selected test result');
                testResults.push(result);
              } else if (url.pathname === '/organization-phase') {
                browserPhase = z
                  .object({
                    phase: z.enum([
                      'registration',
                      'workspace',
                      'workflows',
                      'workflow-navigation',
                      'workflow-open',
                      'workflow-name',
                      'workflow-submit',
                      'workflow-result',
                      'workflow-created',
                      'workflow-create-rejected',
                      'folders',
                      'manager',
                      'tags',
                      'placement',
                      'filters',
                      'unfile',
                      'bulk',
                      'cleanup',
                      'evidence',
                      'roles',
                      'archive',
                      'partial',
                      'default-off',
                    ]),
                  })
                  .strict()
                  .parse(value).phase;
              } else if (url.pathname === '/organization-evidence')
                await verifyEvidence(value);
              else {
                const { instanceId } = z
                  .object({ instanceId: z.uuid() })
                  .strict()
                  .parse(value);
                if (url.pathname === '/browser-opened') {
                  if (openBrowsers.has(instanceId))
                    throw new Error('Duplicate browser receipt');
                  opened = true;
                  openBrowsers.add(instanceId);
                } else if (!openBrowsers.delete(instanceId))
                  throw new Error('Unknown browser receipt');
              }
              response.writeHead(204).end();
            })
            .catch(() => {
              response.writeHead(500).end('Owned organization evidence failed');
            });
          pending.add(command);
          void command.finally(() => {
            pending.delete(command);
          });
        });
      });
      owner.acquire(
        'organization control listener',
        control,
        () =>
          new Promise<void>((resolve, reject) => {
            control.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      );
      await new Promise<void>((resolve, reject) => {
        control.once('error', reject);
        control.listen(0, '127.0.0.1', resolve);
      });
      const address = control.address();
      if (address === null || typeof address === 'string')
        throw new Error('Owned organization listener unavailable');
      const environment = {
        ...process.env,
        EDITOR_BROWSER_INTEGRATION: 'true',
        EDITOR_BROWSER_CASE: 'workflow-organization',
        EDITOR_BROWSER_OWNED_FIXTURE: 'true',
        PERTEXO_API_PROXY_TARGET: await api.listen(),
        PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
        PERTEXO_ORGANIZATION_ROLE: role,
        PERTEXO_ORGANIZATION_BROWSER_DEFAULT_OFF:
          role === 'default-off' ? 'true' : 'false',
      };
      const start = (args: string[], kind: 'vite' | 'browser') =>
        ownChild(
          spawn(process.execPath, args, {
            cwd: webDirectory,
            env: environment,
            stdio: 'ignore',
            detached: true,
          }),
          kind,
        );
      const vite = join(
        dirname(webRequire.resolve('vite/package.json')),
        'bin/vite.js',
      );
      const qualification =
        role === 'default-off'
          ? ['--config', 'vite.config.ts', '--mode', 'production']
          : [
              '--config',
              'vite.organization-qualification.config.ts',
              '--mode',
              'workflow-organization-qualification',
            ];
      // Never accept another preview's healthy HTTP response as readiness for
      // this owned child. A occupied shared lane is not permission to reuse it.
      await assertOrganizationPreviewPortVacant(4174);
      await successfulExit(
        start([vite, 'build', ...qualification], 'vite'),
        'build',
      );
      const preview = start(
        [
          vite,
          'preview',
          ...qualification,
          '--host',
          '127.0.0.1',
          '--port',
          '4174',
          '--strictPort',
        ],
        'vite',
      );
      await waitForOwnedOrganizationPreview(preview, webOrigin);
      await successfulExit(
        start(
          [
            webRequire.resolve('@playwright/test/cli'),
            'test',
            '--config',
            'playwright.live.config.ts',
            'workflow-organization.spec.ts',
            '--grep',
            role === 'default-off'
              ? 'default-off release'
              : 'ordinary owner persists',
          ],
          'browser',
        ),
        'browser',
      );
      expect(opened).toBe(true);
      expect(testResults).toEqual([
        {
          case: role === 'default-off' ? 'default-off' : 'owner',
          status: 'passed',
        },
      ]);
      expect(openBrowsers.size).toBe(0);
      expect(observed).toBe(true);
    }, 180_000);
  },
);
