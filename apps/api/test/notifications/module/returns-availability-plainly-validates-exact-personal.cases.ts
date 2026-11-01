import { NoticePreferencesService } from '../../../src/notifications/preferences/service.js';
import { NoticeConflictError } from '@pertexo/core/notifications';
import {
  createApplicationSecretEnvelope,
  sealNoticeUnsubscribe,
} from '@pertexo/integrations/server';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  workflowId,
  base,
  inboxDatabase,
  hints,
  application,
  session,
  preferenceStore,
} from './fixture.js';

export function registerReturnsAvailabilityPlainlyValidatesExactPersonal(): void {
  it('returns availability plainly and validates an exact personal save at the boundary', async () => {
    const store = preferenceStore();
    const server = await application(
      inboxDatabase(),
      'viewer',
      hints,
      new NoticePreferencesService(store, undefined),
    );
    const read = await server.inject({
      method: 'GET',
      url: `${base}/preferences`,
      headers: session,
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    const unavailable = read.json<{
      emailAvailable: boolean;
      emailUnavailableReason: string;
    }>();
    expect(unavailable.emailAvailable).toBe(false);
    expect(unavailable.emailUnavailableReason).toContain('not configured');
    const key = randomUUID();
    const body = { mode: 'off', hour: 9, timeZone: 'UTC', expectedRevision: 0 };
    const saved = await server.inject({
      method: 'PUT',
      url: `${base}/preferences`,
      headers: { ...session, 'idempotency-key': key },
      payload: body,
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    expect(store.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        workspaceId,
        actorId,
        idempotencyKey: key,
      }),
    );
    const invalid = await server.inject({
      method: 'PUT',
      url: `${base}/preferences`,
      headers: { ...session, 'idempotency-key': randomUUID() },
      payload: {
        ...body,
        timeZone: '+02:00',
        toEmail: 'arbitrary@example.test',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.replace).toHaveBeenCalledTimes(1);
    store.replace.mockRejectedValueOnce(new NoticeConflictError());
    const conflict = await server.inject({
      method: 'PUT',
      url: `${base}/preferences`,
      headers: { ...session, 'idempotency-key': randomUUID() },
      payload: body,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'notifications.changed' });
  });

  it('uses explicit subscribe commands and refuses unknown subject types', async () => {
    const store = preferenceStore();
    const server = await application(
      inboxDatabase(),
      'builder',
      hints,
      new NoticePreferencesService(store, undefined),
    );
    const valid = await server.inject({
      method: 'PUT',
      url: `${base}/subjects/workflow/${workflowId}`,
      headers: { ...session, 'idempotency-key': randomUUID() },
      payload: { followed: true, muted: false, expectedRevision: 0 },
    });
    expect(valid.statusCode, valid.payload).toBe(200);
    expect(store.replaceSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        subjectKind: 'workflow',
        subjectId: workflowId,
        followed: true,
        muted: false,
      }),
    );
    const invalid = await server.inject({
      method: 'GET',
      url: `${base}/subjects/workspace/${workspaceId}`,
      headers: session,
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.readSubscription).not.toHaveBeenCalled();
  });

  it('keeps scanner GET inert and scopes explicit public unsubscribe to a sealed capability', async () => {
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 11).toString('base64') },
    });
    const store = preferenceStore();
    const server = await application(
      inboxDatabase(),
      'owner',
      hints,
      new NoticePreferencesService(store, envelope),
    );
    const path = '/v1/notifications/unsubscribe';
    expect((await server.inject({ method: 'GET', url: path })).statusCode).toBe(
      404,
    );
    expect(store.unsubscribe).not.toHaveBeenCalled();
    const claims = {
      workspaceId,
      actorId,
      revision: 3,
      memberRevision: 5,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const token = sealNoticeUnsubscribe(envelope, claims);
    const submitted = await server.inject({
      method: 'POST',
      url: path,
      headers: { 'x-pertexo-unsubscribe-key': token },
      payload: {},
    });
    expect(submitted.statusCode, submitted.payload).toBe(200);
    expect(submitted.headers['referrer-policy']).toBe('no-referrer');
    expect(submitted.json()).toEqual({ unsubscribed: true });
    expect(store.unsubscribe).toHaveBeenCalledWith(claims);
    const bad = await server.inject({
      method: 'POST',
      url: path,
      headers: { 'x-pertexo-unsubscribe-key': 'invalid' },
      payload: {},
    });
    expect(bad.statusCode).toBe(404);
    expect(store.unsubscribe).toHaveBeenCalledTimes(1);
  });
}
