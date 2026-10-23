import { Module } from '@nestjs/common';

import { afterEach, describe } from 'vitest';
import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';
import { SESSION_AUTHORITY } from '../../src/workspaces/index.js';

import { RequestContextStore } from '../../src/platform/http/index.js';

import {
  actorId,
  FakeIdentityModule,
  cleanAppsApiTestNotificationsModuleTestModuleTestTsFixture,
} from './module/fixture.js';
import { registerListsThreadsOpaqueCursorThisList } from './module/lists-threads-opaque-cursor-this-list.cases.js';
import { registerReturnsAvailabilityPlainlyValidatesExactPersonal } from './module/returns-availability-plainly-validates-exact-personal.cases.js';
import { registerAuthorizesAnonymousOneClickPOSTBy } from './module/authorizes-anonymous-one-click-postby.cases.js';
Module({
  providers: [
    {
      provide: RequestContextStore,
      useValue: { setActor: () => undefined, setWorkspace: () => undefined },
    },
    {
      provide: SESSION_AUTHORITY,
      useValue: {
        authenticate: () =>
          Promise.resolve({
            userId: actorId,
            sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            expiresAt: new Date('2030-01-01T00:00:00.000Z'),
            clientMetadata: {},
          }),
      },
    },
    {
      provide: DoubleSubmitCsrfPolicy,
      useValue: { assertMutationAllowed: () => undefined },
    },
  ],
  exports: [RequestContextStore, SESSION_AUTHORITY, DoubleSubmitCsrfPolicy],
})(FakeIdentityModule);
afterEach(cleanAppsApiTestNotificationsModuleTestModuleTestTsFixture);
describe('notifications HTTP surface', () => {
  registerListsThreadsOpaqueCursorThisList();
});
describe('personal notification HTTP boundaries', () => {
  registerReturnsAvailabilityPlainlyValidatesExactPersonal();
});
registerAuthorizesAnonymousOneClickPOSTBy();
