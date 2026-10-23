import { NoticePreferencesService } from '../../../src/notifications/preferences/service.js';

import {
  createApplicationSecretEnvelope,
  sealNoticeUnsubscribe,
} from '@pertexo/integrations/server';

import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  inboxDatabase,
  hints,
  application,
  preferenceStore,
} from './fixture.js';

export function registerAuthorizesAnonymousOneClickPOSTBy(): void {
  it('authorizes anonymous one-click POST by URL alone, ignores bounded form bodies and keeps GET inert', async () => {
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
    const claims = {
      workspaceId,
      actorId,
      revision: 3,
      memberRevision: 5,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const token = sealNoticeUnsubscribe(envelope, claims);
    const url = `/v1/notifications/unsubscribe/one-click?token=${token}`;
    const get = await server.inject({ method: 'GET', url });
    expect(get.statusCode, get.payload).toBe(303);
    expect(get.headers.location).toBe(`/notifications/unsubscribe#${token}`);
    expect(get.headers['cache-control']).toBe('no-store');
    expect(store.unsubscribe).not.toHaveBeenCalled();
    const submit = (
      payload: string,
      type = 'application/x-www-form-urlencoded',
      target = url,
    ) =>
      server.inject({
        method: 'POST',
        url: target,
        headers: { 'content-type': type },
        payload,
      });
    const accepted = await submit('List-Unsubscribe=One-Click');
    expect(accepted.statusCode, accepted.payload).toBe(200);
    expect(accepted.headers.location).toBeUndefined();
    expect(accepted.json()).toEqual({ unsubscribed: true });
    expect(store.unsubscribe).toHaveBeenLastCalledWith(claims);
    const multipart =
      '--mail-boundary\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--mail-boundary--\r\n';
    expect(
      (await submit(multipart, 'multipart/form-data; boundary=mail-boundary'))
        .statusCode,
    ).toBe(200);
    expect(store.unsubscribe).toHaveBeenCalledTimes(2);
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'multipart/form-data; boundary=unused',
    ]) {
      for (const body of [
        '',
        'unparsed',
        'List-Unsubscribe=wrong',
        'List-Unsubscribe=One-Click&List-Unsubscribe=One-Click',
        '__proto__=value',
        'x'.repeat(8192),
      ]) {
        const response = await submit(body, type);
        expect(response.statusCode, `${type}: ${response.payload}`).toBe(200);
        expect(store.unsubscribe).toHaveBeenLastCalledWith(claims);
      }
      expect((await submit('x'.repeat(8193), type)).statusCode).toBe(413);
    }
    const acceptedCount = store.unsubscribe.mock.calls.length;
    expect(
      (await submit('List-Unsubscribe=One-Click&extra=' + 'x'.repeat(8192)))
        .statusCode,
    ).toBe(413);
    expect(
      (await submit('{"List-Unsubscribe":"One-Click"}', 'application/json'))
        .statusCode,
    ).toBe(415);
    expect(
      (
        await submit(
          multipart,
          'multipart/form-data; boundary=mail-boundary',
          '/v1/notifications/unsubscribe',
        )
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await submit(
          'List-Unsubscribe=One-Click',
          undefined,
          '/v1/notifications/unsubscribe/one-click?token=invalid',
        )
      ).statusCode,
    ).toBe(404);
    const expired = sealNoticeUnsubscribe(envelope, {
      ...claims,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    expect(
      (
        await submit(
          'List-Unsubscribe=One-Click',
          undefined,
          `/v1/notifications/unsubscribe/one-click?token=${expired}`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/notifications/unsubscribe/one-click?token=%0d%0a',
        })
      ).statusCode,
    ).toBe(400);
    const oversized = await submit(
      'List-Unsubscribe=One-Click&extra=' + 'x'.repeat(8192),
    );
    expect(oversized.statusCode).toBe(413);
    expect(oversized.headers['cache-control']).toBe('no-store');
    expect(oversized.headers['referrer-policy']).toBe('no-referrer');
    expect(store.unsubscribe).toHaveBeenCalledTimes(acceptedCount);
  });
}
