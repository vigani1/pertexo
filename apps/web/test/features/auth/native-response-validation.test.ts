import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import {
  signInWithEmail,
  signUpWithEmail,
  resendVerificationEmail,
  requestPasswordReset,
  resetPassword,
} from '@/features/auth/data/native-auth.api';
import { createApiClient, type ApiClient } from '@/lib/api/client';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';

const password = 'a sufficiently long test password';
const email = 'person@example.test';
const cases: readonly Readonly<{
  name: string;
  path: string;
  send: (client: ApiClient) => Promise<unknown>;
}>[] = [
  {
    name: 'sign-in',
    path: 'sign-in/email',
    send: (client) => signInWithEmail(client, { email, password }),
  },
  {
    name: 'registration',
    path: 'sign-up/email',
    send: (client) =>
      signUpWithEmail(client, { displayName: 'Person', email, password }),
  },
  {
    name: 'verification resend',
    path: 'send-verification-email',
    send: (client) => resendVerificationEmail(client, { email }),
  },
  {
    name: 'reset request',
    path: 'request-password-reset',
    send: (client) => requestPasswordReset(client, email),
  },
  {
    name: 'password reset',
    path: 'account-security/password/reset',
    send: (client) =>
      resetPassword(client, { token: 'synthetic-proof', password }),
  },
];

it.each(cases)(
  'refuses to report $name success without the endpoint acknowledgment',
  async ({ path, send }) => {
    mockServer.use(
      http.post(`http://pertexo.test/v1/auth/${path}`, () =>
        HttpResponse.json({}),
      ),
    );
    const client = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    await expect(send(client)).rejects.toMatchObject({
      name: 'NativeAuthenticationError',
      kind: 'protocol',
    });
  },
);
