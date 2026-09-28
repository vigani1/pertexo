import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStructuredLogger } from '@pertexo/observability/logging';
import { workspaceResponseSchema } from '@pertexo/contracts/schemas/identity-workspace';
import {
  workflowCreateResponseSchema,
  workflowGraphSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { FixtureResourceOwner } from './support/fixture-resource-owner.js';
import { useBetterAuthRealApi } from './support/better-auth-real-api.integration.support.js';
import { ownEditorBrowserProcess } from './support/editor-browser-process.js';
import { verifyEditorBrowserOwnership } from './support/editor-browser-ownership.js';
import {
  prepareReadonlyEvidence,
  readonlyEvidenceSchema,
  readonlySetupSchema,
} from './support/editor-readonly-evidence.js';
import {
  expressionAdmissionEvidenceSchema,
  verifyExpressionAdmissionEvidence,
} from './support/editor-expression-admission-evidence.js';
import {
  receiptRecoveryEvidenceSchema,
  runRecoveryEvidenceSchema,
  verifyReceiptRecoveryEvidence,
  verifyRunRecoveryEvidence,
} from './support/editor-browser-recovery-evidence.js';

const enabled = process.env.EDITOR_BROWSER_INTEGRATION === 'true';
const scenario = z
  .enum([
    'nested-conflict',
    'receipts',
    'run-recovery',
    'expression-admission',
    'readonly',
  ])
  .parse(process.env.EDITOR_BROWSER_CASE ?? 'nested-conflict');
const webOrigin = 'http://127.0.0.1:4174';
const workerDirectory = new URL('../../worker/', import.meta.url);
const owner = new FixtureResourceOwner();
const webDirectory = new URL('../../web/', import.meta.url);
const webRequire = createRequire(new URL('package.json', webDirectory));
const browserChildren: ChildProcess[] = [];
const openBrowserInstances = new Set<string>();
let browserWasOpened = false;
const processOwners = new WeakMap<
  ChildProcess,
  ReturnType<typeof ownEditorBrowserProcess>
>();
function ownChild<T extends ChildProcess>(
  name: string,
  child: T,
  kind: 'browser' | 'vite' | 'worker',
): T {
  processOwners.set(
    child,
    ownEditorBrowserProcess(child, kind, {
      browserDisposed: () =>
        browserWasOpened && openBrowserInstances.size === 0,
    }),
  );
  return owner.acquire(name, child, closeChild);
}
let worker: ChildProcess;
const browserEvidenceSchema = z.strictObject({
  runId: z.uuid(),
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  rootId: z.uuid(),
  outerId: z.uuid(),
  innerId: z.uuid(),
  leafId: z.uuid(),
  outsiderWorkspaceId: z.uuid(),
  conflictRevision: z.number().int().positive(),
  finalDraftRevision: z.number().int().positive(),
});
let evidence: z.infer<typeof browserEvidenceSchema> | undefined;
let receiptEvidence: z.infer<typeof receiptRecoveryEvidenceSchema> | undefined;
let runRecoveryEvidence: z.infer<typeof runRecoveryEvidenceSchema> | undefined;
let expressionEvidence:
  z.infer<typeof expressionAdmissionEvidenceSchema> | undefined;
let readonlyFixture:
  Awaited<ReturnType<typeof prepareReadonlyEvidence>> | undefined;
let readonlyEvidence: z.infer<typeof readonlyEvidenceSchema> | undefined;
let readonlySetupPending = false;

function phase(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('error', failed);
      child.off('exit', exited);
      if (error === undefined) resolve();
      else reject(error);
    };
    const message = (value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        'phase' in value &&
        value.phase === expected
      )
        finish();
    };
    const failed = (error: Error) => {
      finish(error);
    };
    const exited = () => {
      finish(new Error(`Owned worker exited before ${expected}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Owned worker did not reach ${expected}`));
    }, 15_000);
    child.on('message', message);
    child.once('error', failed);
    child.once('exit', exited);
  });
}

async function recheckOwnership(): Promise<void> {
  await verifyEditorBrowserOwnership(process.env, async (id) => {
    const { stdout } = await promisify(execFile)('docker', ['inspect', id], {
      timeout: 4_000,
      maxBuffer: 1_048_576,
    });
    return stdout;
  });
}

async function closeChild(child: ChildProcess): Promise<void> {
  const processOwner = processOwners.get(child);
  if (processOwner === undefined)
    throw new Error('Refusing disposal of an unowned process');
  try {
    await processOwner.close();
  } catch (error) {
    // Only fixed fields and allowed system codes, never raw/nested runtime errors.
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['ESRCH', 'EPERM', 'EINVAL'].includes(error.code)
        ? error.code
        : undefined;
    process.stderr.write(
      `Owned process cleanup diagnostic ${JSON.stringify({
        ...processOwner.diagnostics(),
        code,
      })}\n`,
    );
    throw error;
  }
}

describe.skipIf(!enabled)('real browser, API and pure-node worker', () => {
  // Refuse fallback/default database URLs and verify exact owned services before
  // acquiring Redis or allowing the ordinary migrated UUID database fixture.
  beforeAll(async () => {
    await recheckOwnership();
    const probe = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(4174, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }),
    );
    worker = ownChild(
      'pure-node worker process',
      fork('test/editor-browser-worker-process-fixture.ts', [], {
        cwd: workerDirectory,
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: true,
      }),
      'worker',
    );
    // Register the startup observer synchronously before the child can do work.
    worker.on('message', (value: unknown) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('phase' in value) ||
        value.phase !== 'namespace-cleanup-request'
      )
        return;
      void recheckOwnership().then(
        () => {
          if (worker.connected)
            worker.send({ phase: 'namespace-cleanup-approved' });
        },
        () => {
          if (worker.connected)
            worker.send({ phase: 'namespace-cleanup-denied' });
        },
      );
    });
    const ready = phase(worker, 'namespace-ready');
    worker.stderr?.pipe(process.stderr);
    await ready;
  }, 30_000);

  const redis = new URL(process.env.REDIS_URL ?? 'redis://invalid:1/0');
  redis.pathname = '/11';
  const api = useBetterAuthRealApi('editor_browser', {
    publicWebOrigin: webOrigin,
    nodeCompatibilityCohort: 'validate_activation',
    redisUrl: redis.toString(),
    connections: {
      config: {
        kmsKeyReference: 'unused-pure-node-fixture',
        region: 'us-east-1',
      },
      overrides: {
        // Discovery/authorization/persistence are real. This pure-node gate
        // neither provisions credentials nor permits outbound provider calls.
        encryption: {
          value: {
            seal: () =>
              Promise.reject(
                new Error('Credential writes are outside the pure-node gate'),
              ),
            open: () =>
              Promise.reject(
                new Error('Credential reads are outside the pure-node gate'),
              ),
          },
        },
        clients: {
          http: {
            execute: () =>
              Promise.reject(
                new Error('Provider calls are outside the pure-node gate'),
              ),
          },
        },
      },
    },
    logger: createStructuredLogger({
      environment: 'test',
      serviceName: 'pertexo-editor-browser',
      serviceVersion: 'fixture',
      logLevel: 'error',
      otlpHeaders: {},
    }),
    afterMigration: async (databaseUrl) => {
      const ready = phase(worker, 'worker-ready');
      worker.send({
        workerUrl: databaseUrl(process.env.DATABASE_WORKER_URL ?? ''),
        dispatcherUrl: databaseUrl(process.env.DATABASE_DISPATCHER_URL ?? ''),
        apiUrl: databaseUrl(process.env.DATABASE_API_URL ?? ''),
        migrationUrl: databaseUrl(process.env.DATABASE_MIGRATION_URL ?? ''),
      });
      await ready;
    },
    beforeClose: async () => {
      // Stop before worker/lease cleanup if a browser descendant is unconfirmed.
      for (const child of browserChildren.toReversed()) await closeChild(child);
      await owner.close();
    },
    beforeDrop: recheckOwnership,
  });

  it(`executes the owned real-browser scenario: ${scenario}`, async () => {
    // Catch module omissions before launching the browser. These exercise
    // actual request guards and authorized stores, not seeded mock responses.
    const prerequisiteEmail = `prerequisite-${randomUUID()}@integration.test`;
    await api.signUp(prerequisiteEmail, '/workspaces');
    const browser = await api.signIn(prerequisiteEmail);
    const createdWorkspace = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {
        name: 'Fixture prerequisites',
        slug: `pre-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(createdWorkspace.statusCode, createdWorkspace.payload).toBe(201);
    const prerequisiteWorkspace = workspaceResponseSchema.parse(
      createdWorkspace.json(),
    );
    const workspacePath = `/v1/workspaces/${prerequisiteWorkspace.id}`;
    for (const path of [
      '/v1/users/me',
      '/v1/workspaces',
      '/v1/node-definitions',
      '/v1/integrations',
      `${workspacePath}/connections`,
      `${workspacePath}/failure-notification-destinations`,
      `${workspacePath}/workflows`,
      `${workspacePath}/runs`,
      `${workspacePath}/run-statistics`,
    ]) {
      const response = await api.send('GET', path, { browser });
      expect(response.statusCode, `${path}: ${response.payload}`).toBe(200);
    }
    const createdWorkflow = await api.send(
      'POST',
      `${workspacePath}/workflows`,
      {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: { name: 'Prerequisite' },
      },
    );
    expect(createdWorkflow.statusCode, createdWorkflow.payload).toBe(201);
    const prerequisiteWorkflow = workflowCreateResponseSchema.parse(
      createdWorkflow.json(),
    ).workflow;
    for (const path of [
      `${workspacePath}/workflows/${prerequisiteWorkflow.id}`,
      `${workspacePath}/workflows/${prerequisiteWorkflow.id}/draft`,
    ]) {
      const response = await api.send('GET', path, { browser });
      expect(response.statusCode, `${path}: ${response.payload}`).toBe(200);
    }
    const apiOrigin = await api.listen();
    const readiness = await fetch(`${apiOrigin}/health/ready`);
    expect(readiness.status).toBe(200);

    // Separate loopback test-control listener for the local mail sink and
    // non-secret result IDs. This is never registered in the application API.
    const mailServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        request.method === 'POST' &&
        (url.pathname === '/browser-opened' ||
          url.pathname === '/browser-disposed')
      ) {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 128) request.destroy();
        });
        request.on('end', () => {
          try {
            const value: unknown = JSON.parse(body);
            if (
              typeof value !== 'object' ||
              value === null ||
              !('instanceId' in value) ||
              typeof value.instanceId !== 'string' ||
              !/^[a-f0-9-]{36}$/u.test(value.instanceId)
            )
              throw new Error('Invalid browser receipt');
            if (url.pathname === '/browser-opened') {
              browserWasOpened = true;
              openBrowserInstances.add(value.instanceId);
            } else if (!openBrowserInstances.delete(value.instanceId))
              throw new Error('Unknown browser receipt');
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        });
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
      if (request.method === 'POST' && url.pathname === '/readonly-setup') {
        if (
          scenario !== 'readonly' ||
          readonlyFixture !== undefined ||
          readonlySetupPending
        ) {
          response.writeHead(409).end();
          return;
        }
        readonlySetupPending = true;
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1_024) request.destroy();
        });
        request.on('end', () => {
          void (async () => {
            try {
              readonlyFixture = await prepareReadonlyEvidence(
                api.database(),
                readonlySetupSchema.parse(JSON.parse(body)),
              );
              response.setHeader('content-type', 'application/json');
              response.end(JSON.stringify(readonlyFixture.scope));
            } catch {
              response.writeHead(400).end();
            } finally {
              readonlySetupPending = false;
            }
          })();
        });
        return;
      }
      if (
        request.method === 'POST' &&
        (url.pathname === '/evidence' ||
          url.pathname === '/evidence/receipts' ||
          url.pathname === '/evidence/run-recovery' ||
          url.pathname === '/evidence/expression-admission' ||
          url.pathname === '/evidence/readonly')
      ) {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1_024) request.destroy();
        });
        request.on('end', () => {
          try {
            const value: unknown = JSON.parse(body);
            if (url.pathname === '/evidence' && scenario === 'nested-conflict')
              evidence = browserEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/receipts' &&
              scenario === 'receipts'
            )
              receiptEvidence = receiptRecoveryEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/run-recovery' &&
              scenario === 'run-recovery'
            )
              runRecoveryEvidence = runRecoveryEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/expression-admission' &&
              scenario === 'expression-admission'
            )
              expressionEvidence =
                expressionAdmissionEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/readonly' &&
              scenario === 'readonly'
            )
              readonlyEvidence = readonlyEvidenceSchema.parse(value);
            else
              throw new Error('Evidence does not match the selected scenario');
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        });
        return;
      }
      response.writeHead(404).end();
    });
    owner.acquire(
      'mail-sink control listener',
      mailServer,
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          }),
        ),
    );
    await new Promise<void>((resolve, reject) => {
      mailServer.once('error', reject);
      mailServer.listen(0, '127.0.0.1', resolve);
    });
    const address = mailServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Control listener has no TCP address');
    const childEnvironment = {
      ...process.env,
      PERTEXO_API_PROXY_TARGET: apiOrigin,
      PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
    };
    const viteCli = join(
      dirname(webRequire.resolve('vite/package.json')),
      'bin/vite.js',
    );
    const startWebChild = (name: string, args: string[]) => {
      const child = ownChild(
        name,
        spawn(process.execPath, args, {
          cwd: webDirectory,
          env: childEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        }),
        'vite',
      );
      browserChildren.push(child);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      return child;
    };
    const exitedSuccessfully = (child: ChildProcess) =>
      new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Owned web process exited ${String(code)}`));
        });
      });
    await exitedSuccessfully(
      startWebChild('live Vite build', [viteCli, 'build']),
    );
    const preview = startWebChild('live Vite preview', [
      viteCli,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '4174',
      '--strictPort',
    ]);
    const previewStarted = Date.now();
    let previewReady = false;
    while (!previewReady) {
      if (preview.exitCode !== null || preview.signalCode !== null)
        throw new Error('Owned Vite preview exited during startup');
      try {
        const response = await fetch(webOrigin, {
          signal: AbortSignal.timeout(1_000),
        });
        previewReady = response.ok;
      } catch {
        /* The owned listener is not ready yet. */
      }
      if (Date.now() - previewStarted >= 15_000)
        throw new Error('Owned Vite preview did not start');
      await delay(50);
    }
    await new Promise<void>((resolve, reject) => {
      const child = ownChild(
        'live Playwright process',
        spawn(
          process.execPath,
          [
            webRequire.resolve('@playwright/test/cli'),
            'test',
            '--config',
            'playwright.live.config.ts',
            scenario === 'nested-conflict'
              ? 'editor-execution.spec.ts'
              : scenario === 'receipts'
                ? 'editor-receipts.spec.ts'
                : scenario === 'run-recovery'
                  ? 'editor-run-recovery.spec.ts'
                  : scenario === 'expression-admission'
                    ? 'editor-expression-admission.spec.ts'
                    : 'editor-readonly.spec.ts',
          ],
          {
            cwd: webDirectory,
            env: childEnvironment,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          },
        ),
        'browser',
      );
      browserChildren.push(child);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Real browser journey exited ${String(code)}`));
      });
    });
    if (scenario === 'readonly') {
      if (readonlyFixture === undefined || readonlyEvidence === undefined)
        throw new Error('Readonly editor evidence missing');
      await readonlyFixture.verify(readonlyEvidence);
      process.stdout.write(
        `Live browser readonly evidence ${JSON.stringify(readonlyEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'expression-admission') {
      if (expressionEvidence === undefined)
        throw new Error('Expression admission evidence missing');
      await verifyExpressionAdmissionEvidence(
        api.database(),
        expressionEvidence,
      );
      process.stdout.write(
        `Live browser expression admission ${JSON.stringify(expressionEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'receipts') {
      if (receiptEvidence === undefined)
        throw new Error('Receipt recovery evidence missing');
      await verifyReceiptRecoveryEvidence(api.database(), receiptEvidence);
      process.stdout.write(
        `Live browser receipt recovery ${JSON.stringify(receiptEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'run-recovery') {
      if (runRecoveryEvidence === undefined)
        throw new Error('Run recovery evidence missing');
      await verifyRunRecoveryEvidence(api.database(), runRecoveryEvidence);
      process.stdout.write(
        `Live browser run recovery ${JSON.stringify(runRecoveryEvidence)}\n`,
      );
      return;
    }
    expect(evidence).toBeDefined();
    const persisted = await api.database().query<{
      status: string;
      workflow_id: string;
      workspace_id: string;
      workflow_version_id: string;
    }>('select status, workflow_id, workspace_id, workflow_version_id from app.workflow_runs where id=$1', [evidence?.runId]);
    expect(persisted.rows).toEqual([
      {
        status: 'succeeded',
        workflow_id: evidence?.workflowId,
        workspace_id: evidence?.workspaceId,
        workflow_version_id: evidence?.workflowVersionId,
      },
    ]);
    const nodes = await api.database().query<{
      node_id: string;
      status: string;
      invocation_key: string;
      branch_context: unknown;
    }>(
      `select node_id,status,invocation_key,branch_context from app.node_runs
       where workflow_run_id=$1 and workspace_id=$2`,
      [evidence?.runId, evidence?.workspaceId],
    );
    expect(nodes.rows).toHaveLength(8);
    expect(nodes.rows.every((node) => node.status === 'succeeded')).toBe(true);
    const leaves = nodes.rows.filter(
      (node) => node.node_id === evidence?.leafId,
    );
    expect(leaves).toHaveLength(4);
    expect(new Set(leaves.map((node) => node.invocation_key)).size).toBe(4);
    expect(leaves.map((node) => node.branch_context)).toEqual(
      expect.arrayContaining(
        [0, 1].flatMap((outer) =>
          [0, 1].map((inner) => ({
            branchPath: [],
            iterationPath: [
              { loopNodeId: evidence?.outerId, ordinal: outer },
              { loopNodeId: evidence?.innerId, ordinal: inner },
            ],
          })),
        ),
      ),
    );
    expect(
      nodes.rows.filter((node) => node.node_id === evidence?.innerId),
    ).toHaveLength(2);
    const draft = await api
      .database()
      .query<{ revision: number; graph_json: unknown }>(
        'select revision,graph_json from app.workflow_drafts where workflow_id=$1 and workspace_id=$2',
        [evidence?.workflowId, evidence?.workspaceId],
      );
    expect(draft.rows).toHaveLength(1);
    expect(draft.rows[0]?.revision).toBe(evidence?.finalDraftRevision);
    expect(evidence?.finalDraftRevision).toBeGreaterThan(
      evidence?.conflictRevision ?? 0,
    );
    const draftRoot = workflowGraphSchema
      .parse(draft.rows[0]?.graph_json)
      .nodes.find((node) => node.id === evidence?.rootId);
    expect(draftRoot).toMatchObject({
      label: 'Local source choice',
      inputMappings: {
        literalProof: { kind: 'literal', value: 'unpublished-after-run' },
      },
    });
    const versions = await api
      .database()
      .query<{ id: string; graph_json: unknown }>(
        'select id,graph_json from app.workflow_versions where workflow_id=$1 and workspace_id=$2',
        [evidence?.workflowId, evidence?.workspaceId],
      );
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]?.id).toBe(evidence?.workflowVersionId);
    expect(
      workflowGraphSchema
        .parse(versions.rows[0]?.graph_json)
        .nodes.find((node) => node.id === evidence?.rootId),
    ).toMatchObject({
      label: 'Mapping source',
      inputMappings: {
        literalProof: { kind: 'literal', value: 'from-real-browser' },
      },
    });
    const counts = await api
      .database()
      .query<{ count: number }>(
        'select count(*)::int as count from app.workflow_runs where workflow_id=$1 and workspace_id=$2',
        [evidence?.workflowId, evidence?.workspaceId],
      );
    expect(counts.rows).toEqual([{ count: 1 }]);
    process.stdout.write(
      `Live browser durable evidence ${JSON.stringify(evidence)}\n`,
    );
  }, 180_000);
});
