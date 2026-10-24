import { readCsrfToken } from '../../../test/support/browser/csrf';
import { ownedAutomationFailure } from './credential-action';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  apiTokenCredentialSchema,
  strongEtagSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowSummaryResponseSchema,
  workflowVersionsResponseSchema,
  workflowListResponseSchema,
  workflowImportPreviewResponseSchema,
  workflowImportResponseSchema,
  workflowPublishResponseSchema,
  workflowRunStartResponseSchema,
  workflowRunResponseSchema,
  workflowRunListResponseSchema,
} from '@pertexo/contracts';
import {
  portableGraphDigest,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';
import { automationCli } from './cli';

export async function qualifyAutomationCli(page: Page, workspaceId: string) {
  let phase = 'workflow-create';
  try {
    const csrf = await readCsrfToken(page);
    const base = `/v1/workspaces/${workspaceId}`;
    const created = await page.request.post(`${base}/workflows`, {
      headers: {
        'x-csrf-token': csrf,
        'Idempotency-Key': randomUUID(),
      },
      data: { name: 'CLI immutable source' },
    });
    expect(created.status()).toBe(201);
    const sourceWorkflowId = workflowCreateResponseSchema.parse(
      await created.json(),
    ).workflow.id;
    const graph = {
      nodes: [
        {
          id: randomUUID(),
          definition: { key: 'core.set', version: 1 },
          configVersion: 1,
          config: {},
          inputMappings: { value: { kind: 'run_input', path: '$.value' } },
          connectionRefs: {},
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      settings: {},
    };
    phase = 'draft-save';
    const saved = await page.request.put(
      `${base}/workflows/${sourceWorkflowId}/draft`,
      {
        headers: {
          'x-csrf-token': csrf,
          'If-Match': strongEtagSchema.parse(created.headers().etag),
        },
        data: { graph },
      },
    );
    expect(saved.status()).toBe(200);
    phase = 'token-create';
    await page
      .getByRole('button', { name: 'Create token', exact: true })
      .click();
    await page
      .getByLabel('Token name', { exact: true })
      .fill('Live CLI runner');
    for (const name of [
      'Read workflows',
      'Import workflows',
      'Publish workflows',
      'Read runs',
      'Start runs',
      'Cancel runs',
    ])
      await page.getByRole('checkbox', { name, exact: true }).check();
    await page
      .getByRole('button', { name: 'Create token', exact: true })
      .click();
    const secretField = page.getByLabel('API token secret', { exact: true });
    await expect(secretField).toBeVisible();
    const credential = apiTokenCredentialSchema.parse(
      await secretField.inputValue(),
    );
    const tokenId = credential.split('.')[2];
    if (tokenId === undefined) throw new Error('Token ID missing');
    await page
      .getByRole('checkbox', { name: 'I’ve saved this token', exact: true })
      .check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const origin = new URL(page.url()).origin;
    const call = async (args: string[]) => {
      phase = args.slice(0, 2).join('.');
      const reply = await automationCli(origin, credential, [
        ...args,
        '--workspace',
        workspaceId,
      ]);
      if (reply.code !== 0) throw ownedAutomationFailure(phase, reply.body);
      expect(reply.code).toBe(0);
      return reply.body;
    };
    const dir = await mkdtemp(join(tmpdir(), 'pertexo-live-cli-'));
    const file = async (name: string, body: unknown) => {
      const path = join(dir, name);
      await writeFile(path, JSON.stringify(body));
      return path;
    };
    try {
      expect(
        workflowListResponseSchema
          .parse(await call(['workflows', 'list']))
          .items.map((item) => item.id),
      ).toContain(sourceWorkflowId);
      expect(
        workflowSummaryResponseSchema.parse(
          await call(['workflows', 'get', '--workflow', sourceWorkflowId]),
        ).workflow.id,
      ).toBe(sourceWorkflowId);
      const draftResult = await call([
        'workflows',
        'draft',
        '--workflow',
        sourceWorkflowId,
      ]);
      const { etag, ...draftBody } = workflowDraftResponseSchema
        .extend({ etag: strongEtagSchema })
        .parse(draftResult);
      const draft = workflowDraftResponseSchema.parse(draftBody);
      expect(draft.graph).toEqual(graph);
      const exportFile = await file('export.json', {
        source: { kind: 'draft' },
        reviewedGraphDigest: await portableGraphDigest(draft.graph),
      });
      const manifest = workflowPortableManifestSchema.parse(
        await call([
          'workflows',
          'export',
          '--workflow',
          sourceWorkflowId,
          '--etag',
          etag,
          '--body',
          exportFile,
        ]),
      );
      const previewFile = await file('preview.json', {
        manifest,
        bindings: [],
      });
      const preview = workflowImportPreviewResponseSchema.parse(
        await call(['workflows', 'import-preview', '--body', previewFile]),
      );
      expect(preview.compatible).toBe(true);
      const importFile = await file('import.json', {
        manifest,
        bindings: [],
        name: 'CLI imported copy',
        expectedCompatibilityFingerprint: preview.compatibilityFingerprint,
      });
      const importArgs = [
        'workflows',
        'import',
        '--body',
        importFile,
        '--key',
        'live-cli-import',
      ];
      const importedWorkflowId = workflowImportResponseSchema.parse(
        await call(importArgs),
      ).workflowId;
      expect(
        workflowImportResponseSchema.parse(await call(importArgs)).workflowId,
      ).toBe(importedWorkflowId);
      expect(
        workflowVersionsResponseSchema.parse(
          await call([
            'workflows',
            'versions',
            '--workflow',
            importedWorkflowId,
          ]),
        ).items,
      ).toHaveLength(0);
      const reviewed = workflowDraftResponseSchema
        .extend({ etag: strongEtagSchema })
        .parse(
          await call(['workflows', 'draft', '--workflow', importedWorkflowId]),
        );
      const publishArgs = [
        'workflows',
        'publish',
        '--workflow',
        importedWorkflowId,
        '--etag',
        reviewed.etag,
        '--key',
        'live-cli-publish',
      ];
      const published = workflowPublishResponseSchema.parse(
        await call(publishArgs),
      );
      expect(
        workflowPublishResponseSchema.parse(await call(publishArgs)).version.id,
      ).toBe(published.version.id);
      const runFile = await file('run.json', {
        expectedPublishedVersionId: published.version.id,
        input: { value: 'completed CLI qualification' },
      });
      const startArgs = [
        'runs',
        'start',
        '--workflow',
        importedWorkflowId,
        '--body',
        runFile,
        '--key',
        'live-cli-start',
      ];
      const started = workflowRunStartResponseSchema.parse(
        await call(startArgs),
      );
      expect(
        workflowRunStartResponseSchema.parse(await call(startArgs)).run.id,
      ).toBe(started.run.id);
      await expect
        .poll(
          async () =>
            workflowRunResponseSchema.parse(
              await call(['runs', 'get', '--run', started.run.id]),
            ).run.status,
          { timeout: 30_000 },
        )
        .toBe('succeeded');
      expect(
        workflowRunListResponseSchema
          .parse(await call(['runs', 'list', '--workflow', importedWorkflowId]))
          .items.map((item) => item.id),
      ).toEqual([started.run.id]);
      phase = 'runs.cancel';
      const terminalCancel = await automationCli(origin, credential, [
        'runs',
        'cancel',
        '--workspace',
        workspaceId,
        '--run',
        started.run.id,
      ]);
      expect(terminalCancel.code).toBe(1);
      expect(terminalCancel.body).toMatchObject({ code: 'run.not_cancelable' });
      phase = 'token-revoke';
      await page
        .getByRole('button', { name: 'Revoke Live CLI runner', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Revoke token', exact: true })
        .click();
      await expect(
        page.getByRole('button', {
          name: 'Revoke Live CLI runner',
          exact: true,
        }),
      ).toHaveCount(0);
      phase = 'token-revocation-check';
      const denied = await automationCli(origin, credential, [
        'workflows',
        'list',
        '--workspace',
        workspaceId,
      ]);
      expect(denied.code).toBe(1);
      expect(denied.body).toMatchObject({ code: 'auth.unauthenticated' });
      return {
        tokenId,
        sourceWorkflowId,
        importedWorkflowId,
        versionId: published.version.id,
        runId: started.run.id,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    throw ownedAutomationFailure(phase, error);
  }
}
