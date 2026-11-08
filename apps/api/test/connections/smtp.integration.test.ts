import { randomBytes, randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createTokenWorkspace } from '../api-tokens/api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'SMTP connections on the real API',
  () => {
    let port = 0;
    let messages = 0;
    const relay = new SMTPServer({
      logger: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      onAuth: (auth, _session, callback) => {
        if (auth.password === 'refused-password')
          callback(
            Object.assign(new Error('private-authentication-reply'), {
              responseCode: 535,
            }),
          );
        else callback(null, { user: 'ada' });
      },
      onMailFrom: (address, _session, callback) => {
        if (address.address === 'blocked@example.test')
          callback(
            Object.assign(new Error('private-sender-reply'), {
              responseCode: 550,
            }),
          );
        else callback();
      },
      onData: (stream, _session, callback) => {
        messages += 1;
        stream.resume();
        stream.on('end', callback);
      },
    });
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      randomBytes(32),
      'connection',
    );
    const api = useBetterAuthRealApi('smtp_connections', {
      automationTokens: true,
      connections: {
        config: { kmsKeyReference: 'smtp-fixture', region: 'us-east-1' },
        services: () => ({
          encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
          smtpPolicy: {
            allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
            allowPlaintext: true,
          },
        }),
      },
    });
    beforeAll(async () => {
      await new Promise<void>((resolve) =>
        relay.listen(0, '127.0.0.1', resolve),
      );
      const address = relay.server.address();
      if (!address || typeof address === 'string')
        throw new Error('No SMTP fixture port');
      port = address.port;
    });
    afterAll(async () => {
      keys.close();
      await new Promise<void>((resolve) => {
        relay.close(resolve);
      });
    });
    it('seals credentials and tests the relay without sending a message', async () => {
      const w = await createTokenWorkspace({ api, listen: () => api.listen() });
      const password = 'smtp-password-must-stay-private';
      const created = await api.send('POST', `${w.base}/connections`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'email',
          name: 'Workspace relay',
          credential: {
            type: 'smtp',
            host: '127.0.0.1',
            port,
            security: 'none',
            username: 'ada',
            password,
            fromEmail: 'alerts@example.test',
          },
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      expect(created.payload).not.toContain(password);
      const id = created.json<{ id: string }>().id;
      const tested = await api.send(
        'POST',
        `${w.base}/connections/${id}/test`,
        {
          browser: w.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { providerKey: 'email', transport: 'smtp' },
        },
      );
      expect(tested.statusCode, tested.payload).toBe(200);
      expect(tested.json<{ outcome: { ok: boolean } }>().outcome.ok).toBe(true);
      expect(tested.payload).not.toContain(password);
      expect(messages).toBe(0);
      const stored = await api
        .database()
        .query(
          'select ciphertext from app.connection_secret_versions where connection_id=$1',
          [id],
        );
      expect(JSON.stringify(stored.rows)).not.toContain(password);
    });
    it.each([
      ['TLS', { security: 'starttls' }, 'connection.smtp_tls'],
      [
        'authentication',
        { password: 'refused-password' },
        'connection.smtp_authentication',
      ],
      [
        'blocked address',
        { host: '169.254.169.254' },
        'connection.smtp_network',
      ],
    ] as const)(
      'reports a safe %s failure from the connection test',
      async (_name, overrides, errorCode) => {
        const w = await createTokenWorkspace({
          api,
          listen: () => api.listen(),
        });
        const created = await api.send('POST', `${w.base}/connections`, {
          browser: w.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            providerKey: 'email',
            name: 'Failure probe',
            credential: {
              type: 'smtp',
              host: '127.0.0.1',
              port,
              security: 'none',
              username: 'ada',
              password: 'private-password',
              fromEmail: 'alerts@example.test',
              ...overrides,
            },
          },
        });
        expect(created.statusCode, created.payload).toBe(201);
        const id = created.json<{ id: string }>().id;
        const tested = await api.send(
          'POST',
          `${w.base}/connections/${id}/test`,
          {
            browser: w.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { providerKey: 'email', transport: 'smtp' },
          },
        );
        expect(tested.statusCode, tested.payload).toBe(200);
        expect(tested.json<{ outcome: unknown }>().outcome).toMatchObject({
          ok: false,
          errorCode,
        });
        expect(tested.payload).not.toMatch(
          /private-password|refused-password|private-authentication-reply/u,
        );
        expect(messages).toBe(0);
      },
    );
    it('reports sender refusal safely when testing an actual alert destination', async () => {
      const w = await createTokenWorkspace({ api, listen: () => api.listen() });
      const created = await api.send('POST', `${w.base}/connections`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'email',
          name: 'Sender probe',
          credential: {
            type: 'smtp',
            host: '127.0.0.1',
            port,
            security: 'none',
            username: 'ada',
            password: 'private-password',
            fromEmail: 'blocked@example.test',
          },
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const connectionId = created.json<{ id: string }>().id;
      const destinations = `${w.base}/failure-notification-destinations`;
      const destination = await api.send('POST', destinations, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          kind: 'email',
          connectionId,
          toEmail: 'member@example.test',
        },
      });
      expect(destination.statusCode, destination.payload).toBe(201);
      const id = destination.json<{ id: string }>().id;
      const tested = await api.send('POST', `${destinations}/${id}/test`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { expectedVersion: 1, sideEffectDisclosureAccepted: true },
      });
      expect(tested.statusCode, tested.payload).toBe(200);
      expect(tested.json<{ outcome: unknown }>().outcome).toMatchObject({
        ok: false,
        errorCode: 'connection.smtp_sender_rejected',
      });
      expect(tested.payload).not.toMatch(
        /private-password|private-sender-reply/u,
      );
      expect(messages).toBe(0);
    });
    it('refuses a Resend-style probe for SMTP without sending mail', async () => {
      const w = await createTokenWorkspace({ api, listen: () => api.listen() });
      const created = await api.send('POST', `${w.base}/connections`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'email',
          name: 'SMTP test kind',
          credential: {
            type: 'smtp',
            host: '127.0.0.1',
            port,
            security: 'none',
            username: 'ada',
            password: 'private-password',
            fromEmail: 'alerts@example.test',
          },
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const id = created.json<{ id: string }>().id;
      const tested = await api.send(
        'POST',
        `${w.base}/connections/${id}/test`,
        {
          browser: w.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { providerKey: 'email', sideEffectDisclosureAccepted: true },
        },
      );
      expect(tested.statusCode, tested.payload).toBe(400);
      expect(
        tested.json<{ errors: { path: string }[] }>().errors,
      ).toContainEqual(expect.objectContaining({ path: '/transport' }));
      expect(messages).toBe(0);
    });
  },
);

describe.runIf(betterAuthIntegrationEnabled)(
  'SMTP plaintext operator policy',
  () => {
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      randomBytes(32),
      'connection',
    );
    const api = useBetterAuthRealApi('smtp_plaintext_policy', {
      automationTokens: true,
      connections: {
        config: { kmsKeyReference: 'smtp-policy-fixture', region: 'us-east-1' },
        services: () => ({
          encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
        }),
      },
    });
    afterAll(() => {
      keys.close();
    });
    it('refuses unencrypted SMTP by default with a field error and no secret echo', async () => {
      const w = await createTokenWorkspace({ api, listen: () => api.listen() });
      const reply = await api.send('POST', `${w.base}/connections`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          providerKey: 'email',
          name: 'Refused plain relay',
          credential: {
            type: 'smtp',
            host: 'relay.example.test',
            port: 25,
            security: 'none',
            username: 'ada',
            password: 'private-policy-password',
            fromEmail: 'alerts@example.test',
          },
        },
      });
      expect(reply.statusCode, reply.payload).toBe(400);
      expect(
        reply
          .json<{ errors: { path: string }[] }>()
          .errors.map((issue) => issue.path),
      ).toContain('/credential/security');
      expect(reply.payload).not.toContain('private-policy-password');
    });
  },
);
