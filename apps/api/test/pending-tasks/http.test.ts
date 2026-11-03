import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PendingTasksController } from '../../src/pending-tasks/pending-tasks.controller.js';
import { PendingTaskService } from '../../src/pending-tasks/pending-task.service.js';
import {
  browserHeaders,
  foreignWorkspaceId,
  sessionActorId,
  sessionHttpApp,
  sessionWorkspaceId,
} from '../support/session-http.js';

const taskId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const uploadSession = 'U'.repeat(43);
/** A decided approval, in the shape the route answers with. */
const decided = {
  task: {
    id: taskId,
    workspaceId: sessionWorkspaceId,
    workflowId: '11111111-1111-4111-8111-111111111111',
    workflowName: 'Invoices',
    runId: '22222222-2222-4222-8222-222222222222',
    nodeId: 'approve',
    stepName: null,
    nodeRunId: '33333333-3333-4333-8333-333333333333',
    iterationPath: [],
    kind: 'approval',
    title: 'Approve the invoice',
    details: {},
    status: 'approved',
    createdAt: '2026-08-21T12:00:00.000Z',
    expiresAt: '2026-08-28T12:00:00.000Z',
    onExpiry: 'fail',
    completedAt: '2026-08-21T12:05:00.000Z',
    completedByName: 'Owner',
    canRespond: false,
    blockedReason: 'resolved',
    workflowVersionId: '44444444-4444-4444-8444-444444444444',
    instructions: '',
    audience: { roles: ['owner'], memberIds: [] },
    output: null,
  },
  replayed: false,
};

const mutations = [
  {
    name: 'decide',
    payload: { decision: 'approved', comment: 'Looks right' },
  },
  { name: 'submit', payload: { values: { amount: 12 } } },
] as const;

const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function tasksApp() {
  const tasks = {
    decide: vi.fn().mockResolvedValue(decided),
    submit: vi.fn().mockResolvedValue(decided),
  };
  const fixture = await sessionHttpApp({
    controller: PendingTasksController,
    providers: [{ provide: PendingTaskService, useValue: tasks }],
    fields: { tasks },
  });
  apps.push(fixture.app);
  return { ...fixture, tasks };
}

function url(name: string, workspaceId = sessionWorkspaceId): string {
  return `/v1/workspaces/${workspaceId}/pending-tasks/${taskId}/${name}`;
}

describe('pending task decisions over HTTP', () => {
  it.each(mutations)(
    '$name needs a signed-in session',
    async ({ name, payload }) => {
      const { app, tasks } = await tasksApp();
      const response = await app.inject({
        method: 'POST',
        url: url(name),
        headers: { 'idempotency-key': 'k' },
        payload,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'auth.unauthenticated' });
      expect(tasks[name]).not.toHaveBeenCalled();
    },
  );

  it.each(mutations)(
    '$name refuses a cross-site request without the CSRF pair',
    async ({ name, payload }) => {
      const { app, tasks } = await tasksApp();
      const response = await app.inject({
        method: 'POST',
        url: url(name),
        headers: browserHeaders({ csrf: false, idempotencyKey: 'k' }),
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'auth.forbidden',
        detail: 'The request could not be verified.',
      });
      expect(tasks[name]).not.toHaveBeenCalled();
    },
  );

  it.each(mutations)(
    '$name hides a workspace the person is not a member of',
    async ({ name, payload }) => {
      const { app, tasks } = await tasksApp();
      const response = await app.inject({
        method: 'POST',
        url: url(name, foreignWorkspaceId),
        headers: browserHeaders({ idempotencyKey: 'k' }),
        payload,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'resource.not_found' });
      expect(tasks[name]).not.toHaveBeenCalled();
    },
  );

  it('records an approval decision for the signed-in person', async () => {
    const { app, tasks } = await tasksApp();
    const response = await app.inject({
      method: 'POST',
      url: url('decide'),
      headers: browserHeaders({ idempotencyKey: 'decide-1' }),
      payload: { decision: 'approved', comment: 'Looks right' },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(tasks.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: sessionWorkspaceId,
        taskId,
        decision: 'approved',
        comment: 'Looks right',
        actorId: sessionActorId,
        idempotencyKey: 'decide-1',
      }),
    );
  });

  it('submits form values with the response session that owns their uploads', async () => {
    const { app, tasks } = await tasksApp();
    const response = await app.inject({
      method: 'POST',
      url: url('submit'),
      headers: {
        ...browserHeaders({ idempotencyKey: 'submit-1' }),
        'x-pertexo-form-session': uploadSession,
      },
      payload: { values: { amount: 12 } },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(tasks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: sessionWorkspaceId,
        taskId,
        values: { amount: 12 },
        uploadSession,
        actorId: sessionActorId,
        idempotencyKey: 'submit-1',
      }),
    );
  });

  it('submits values without uploads with no response session', async () => {
    const { app, tasks } = await tasksApp();
    const response = await app.inject({
      method: 'POST',
      url: url('submit'),
      headers: browserHeaders({ idempotencyKey: 'submit-2' }),
      payload: { values: {} },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(tasks.submit.mock.calls[0]?.[0]).not.toHaveProperty('uploadSession');
  });

  it('refuses a malformed response session before submitting', async () => {
    const { app, tasks } = await tasksApp();
    const response = await app.inject({
      method: 'POST',
      url: url('submit'),
      headers: {
        ...browserHeaders({ idempotencyKey: 'submit-3' }),
        'x-pertexo-form-session': 'short',
      },
      payload: { values: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'request.invalid' });
    expect(tasks.submit).not.toHaveBeenCalled();
  });
});
