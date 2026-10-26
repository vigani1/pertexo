import { createCallbackTokenKeys } from '@pertexo/integrations/server';

import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';
import { z } from 'zod';

import { restartEditorBrowserWorker } from '../../harness/worker-restart.js';
import {
  observeScheduleBeforeDue,
  scheduleScopeSchema,
} from '../evidence/schedule.js';
import {
  prepareReadonlyEvidence,
  readonlySetupSchema,
} from '../evidence/readonly.js';

import { scenario, callbackConfig } from '../fixture/environment.js';
import { fixtureState } from '../fixture/state.js';
import {
  restartScope,
  assertRestartScopeActive,
} from '../fixture/lifecycle.js';
import type { EditorControlRequest } from './contract.js';

export function handleEditorCallbackResume(
  input: EditorControlRequest,
): boolean {
  const { request, response, url, context } = input;
  const { api, apiOrigin } = context;
  if (
    scenario === 'approvals' &&
    request.method === 'POST' &&
    url.pathname === '/callback-resume'
  ) {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array))
          throw new Error('Invalid callback fixture bytes');
        chunks.push(Buffer.from(chunk));
        if (chunks.reduce((sum, value) => sum + value.byteLength, 0) > 1024)
          throw new Error('Callback fixture command too large');
      }
      const input = z
        .object({ workspaceId: z.uuid(), runId: z.uuid() })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const found = await api
        .database()
        .query<{ id: string; callback_key_version: string }>(
          "select task.id,task.callback_key_version from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id where task.workspace_id=$1 and task.run_id=$2 and task.kind='callback' and task.status='pending' and run.trigger_type='test'",
          [input.workspaceId, input.runId],
        );
      const task = found.rows[0];
      if (task === undefined) throw new Error('No owned pending test callback');
      const keys = createCallbackTokenKeys(callbackConfig);
      try {
        const token = keys.material(task, task.callback_key_version).token;
        const accepted = await fetch(`${apiOrigin}/hooks/${token}/resume`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ completed: 'callback-browser-proof' }),
        });
        if (accepted.status !== 202)
          throw new Error('Callback fixture refused');
        response.writeHead(204);
        response.end();
      } finally {
        keys.close();
      }
    })().catch(() => {
      response.writeHead(500);
      response.end('Callback qualification failed');
    });
    return true;
  }
  return false;
}

/**
 * Brings an owned run's open Approval or Request input to its expiry now,
 * keeping its window, so the due scanner settles it as real time would.
 */
export function handleEditorTaskExpiry(input: EditorControlRequest): boolean {
  const { request, response, url, context } = input;
  if (
    scenario !== 'task-timeouts' ||
    request.method !== 'POST' ||
    url.pathname !== '/task-expire'
  )
    return false;
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!(chunk instanceof Uint8Array))
        throw new Error('Invalid task expiry command bytes');
      chunks.push(Buffer.from(chunk));
      if (chunks.reduce((sum, value) => sum + value.byteLength, 0) > 1024)
        throw new Error('Task expiry command too large');
    }
    const target = z
      .object({ workspaceId: z.uuid(), runId: z.uuid() })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const database = context.api.database();
    const moved = await database.query(
      "update app.pending_run_tasks set created_at=created_at-(expires_at-clock_timestamp()),expires_at=clock_timestamp() where workspace_id=$1 and run_id=$2 and status='pending' and kind in ('approval','input_request')",
      [target.workspaceId, target.runId],
    );
    if (moved.rowCount !== 1) throw new Error('No owned open task to expire');
    await database.query(
      "update app.node_runs set resume_at=clock_timestamp() where workspace_id=$1 and workflow_run_id=$2 and status='waiting' and control_kind='human_task'",
      [target.workspaceId, target.runId],
    );
    response.writeHead(204).end();
  })().catch(() => {
    response.writeHead(500).end('Task expiry qualification failed');
  });
  return true;
}

export function handleEditorPortabilityDenial(
  input: EditorControlRequest,
): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'POST' &&
    url.pathname === '/workflow-portability-deny' &&
    scenario === 'portability' &&
    fixtureState.portabilityFixture !== undefined
  ) {
    void fixtureState.portabilityFixture.deny().then(
      () => response.writeHead(204).end(),
      () => response.writeHead(400).end(),
    );
    return true;
  }
  return false;
}

export function handleEditorReadonlySetup(
  input: EditorControlRequest,
): boolean {
  const { request, response, url, context } = input;
  const { api } = context;
  if (request.method === 'POST' && url.pathname === '/readonly-setup') {
    if (
      !['readonly', 'approvals', 'governance', 'collaboration'].includes(
        scenario,
      ) ||
      fixtureState.readonlyFixture !== undefined ||
      fixtureState.readonlySetupPending
    ) {
      response.writeHead(409).end();
      return true;
    }
    fixtureState.readonlySetupPending = true;
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_024) request.destroy();
    });
    request.on('end', () => {
      void (async () => {
        try {
          fixtureState.readonlyFixture = await prepareReadonlyEvidence(
            api.database(),
            readonlySetupSchema.parse(JSON.parse(body)),
          );
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(fixtureState.readonlyFixture.scope));
        } catch {
          response.writeHead(400).end();
        } finally {
          fixtureState.readonlySetupPending = false;
        }
      })();
    });
    return true;
  }
  return false;
}

export function handleEditorScheduleRestart(
  input: EditorControlRequest,
): boolean {
  const { request, response, url, context } = input;
  const { api, fixture } = context;
  if (request.method === 'POST' && url.pathname === '/schedule-restart') {
    if (
      scenario !== 'schedule' ||
      fixtureState.scheduleRestartUsed ||
      restartScope.signal.aborted
    ) {
      response.writeHead(409).end();
      return true;
    }
    fixtureState.scheduleRestartUsed = true;
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_024) request.destroy();
    });
    request.on('end', () => {
      void (async () => {
        try {
          const scope = scheduleScopeSchema.parse(JSON.parse(body));
          const before = await observeScheduleBeforeDue(api.database(), scope);
          const requestId = randomUUID();
          await restartEditorBrowserWorker(
            fixture.worker,
            requestId,
            restartScope.signal,
          );
          assertRestartScopeActive();
          const after = await observeScheduleBeforeDue(api.database(), scope);
          assertRestartScopeActive();
          expect({ ...after, observedAt: before.observedAt }).toEqual(before);
          fixtureState.scheduleRestart = {
            scope,
            triggerId: before.triggerId,
            nextFireAt: before.nextFireAt,
            requestId,
          };
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              ...fixtureState.scheduleRestart,
              beforeObservedAt: before.observedAt,
              afterObservedAt: after.observedAt,
            }),
          );
        } catch {
          response.writeHead(400).end();
        }
      })();
    });
    return true;
  }
  return false;
}
