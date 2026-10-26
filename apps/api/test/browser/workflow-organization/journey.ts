import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
  assertOrganizationPreviewPortVacant,
  waitForOwnedOrganizationPreview,
} from '../workflow-organization-lifetime.js';

import {
  webOrigin,
  webDirectory,
  webRequire,
  evidenceSchema,
  matrixSchema,
} from './environment.js';
import type { createWorkflowOrganizationJourney } from './fixture.js';
import { createOrganizationInvitationDelivery } from './mail.js';
import { liveWebPort } from '../web-origin.js';

export function registerWorkflowOrganizationJourney(
  fixture: ReturnType<typeof createWorkflowOrganizationJourney>,
): void {
  const {
    api,
    owner,
    role,
    testResults,
    openBrowsers,
    pending,
    ownChild,
    successfulExit,
  } = fixture;
  it('qualifies ordinary owner management, filters, private favorite and exact bounded recovery', async () => {
    const { deliverInvitation } = await createOrganizationInvitationDelivery({
      api,
      owner,
    });

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
      fixture.observed = true;
    }
    const control = createServer((request, response) => {
      response.setHeader('cache-control', 'no-store');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        fixture.closing &&
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
                  control: z
                    .object({
                      action: z.enum(['favorite', 'invitation', 'other']),
                      matches: z.number().int().min(0).max(100),
                      enabled: z.boolean().nullable(),
                    })
                    .strict()
                    .nullable(),
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
              fixture.failureLine = diagnostic.line;
              if (diagnostic.control !== null) {
                const { action, matches, enabled } = diagnostic.control;
                fixture.controlFailure = `${action}:${String(matches)}:${String(enabled)}`;
              }
              fixture.identityFailure = `${diagnostic.identityStage}:${String(diagnostic.identityStatus)}`;
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
              expect(members.rows.map((member) => member.role).sort()).toEqual(
                ['owner', role].sort(),
              );
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
              fixture.publicEvidence = evidence;
            } else if (url.pathname === '/organization-test-result') {
              const result = z
                .object({
                  case: z.literal('owner'),
                  status: z.enum(['passed', 'failed']),
                })
                .strict()
                .parse(value);
              if (testResults.length !== 0)
                throw new Error('Duplicate selected test result');
              testResults.push(result);
            } else if (url.pathname === '/organization-phase') {
              fixture.browserPhase = z
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
                    'folder-sharing',
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
                fixture.opened = true;
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
    };
    const start = (args: string[], kind: 'vite' | 'browser') =>
      ownChild(
        spawn(process.execPath, args, {
          cwd: webDirectory,
          env:
            kind === 'vite'
              ? { ...environment, NODE_ENV: 'production' }
              : environment,
          stdio: 'ignore',
          detached: true,
        }),
        kind,
      );
    const vite = join(
      dirname(webRequire.resolve('vite/package.json')),
      'bin/vite.js',
    );
    // Never accept another preview's healthy HTTP response as readiness for
    // this owned child. A occupied shared lane is not permission to reuse it.
    await assertOrganizationPreviewPortVacant(liveWebPort);
    await successfulExit(start([vite, 'build'], 'vite'), 'build');
    const preview = start(
      [
        vite,
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(liveWebPort),
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
          'ordinary owner persists',
        ],
        'browser',
      ),
      'browser',
    );
    expect(fixture.opened).toBe(true);
    expect(testResults).toEqual([{ case: 'owner', status: 'passed' }]);
    expect(openBrowsers.size).toBe(0);
    expect(fixture.observed).toBe(true);
  }, 180_000);
}
