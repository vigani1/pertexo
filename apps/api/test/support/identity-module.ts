import { Module } from '@nestjs/common';
import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';
import {
  SESSION_AUTHORITY,
  SessionAuthenticationGuard,
} from '../../src/workspaces/index.js';
import { RequestContextStore } from '../../src/platform/http/index.js';
import { ApiTokenAuthentication } from '../../src/authentication/automation/authority.js';
// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class FakeIdentityModule {}
const sessions = {
  authenticate: () =>
    Promise.resolve({
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      clientMetadata: {},
    }),
};
const noTokenVerifies = { authenticate: () => Promise.resolve(undefined) };

Module({
  providers: [
    {
      provide: RequestContextStore,
      useValue: { setActor: () => undefined, setWorkspace: () => undefined },
    },
    { provide: SESSION_AUTHORITY, useValue: sessions },
    {
      provide: DoubleSubmitCsrfPolicy,
      useValue: { assertMutationAllowed: () => undefined },
    },
    // Routes a token may call fall back to the session when no token is sent.
    { provide: ApiTokenAuthentication, useValue: noTokenVerifies },
    {
      provide: SessionAuthenticationGuard,
      useFactory: (contexts: RequestContextStore) =>
        new SessionAuthenticationGuard(sessions as never, contexts),
      inject: [RequestContextStore],
    },
  ],
  exports: [
    RequestContextStore,
    SESSION_AUTHORITY,
    DoubleSubmitCsrfPolicy,
    ApiTokenAuthentication,
    SessionAuthenticationGuard,
  ],
})(FakeIdentityModule);
