import { describe } from 'vitest';

import { installExecutionAcceptanceFixture } from '../../runs/acceptance/fixtures.js';

import { registerPersistsAcceptanceTicketsOnceExact } from './concurrency-admission/persists-acceptance-tickets-once-exact.cases.js';
import { registerReservationRecoveryReplacesTransportIdentity } from './concurrency-admission/reservation-recovery-replaces-transport-identity.cases.js';
import { registerSkipsWorkspaceLifecycleLockBefore } from './concurrency-admission/skips-workspace-lifecycle-lock-before.cases.js';
import { registerExpiresCommandReceiptsAfterTwenty } from './concurrency-admission/expires-command-receipts-after-twenty.cases.js';
import { registerExplainsWorkspaceCapacityBlockers } from './concurrency-admission/explains-workspace-capacity-blockers.cases.js';
installExecutionAcceptanceFixture();
describe('current workflow concurrency and ordered production admission', () => {
  registerPersistsAcceptanceTicketsOnceExact();

  registerReservationRecoveryReplacesTransportIdentity();

  registerExplainsWorkspaceCapacityBlockers();

  registerSkipsWorkspaceLifecycleLockBefore();

  registerExpiresCommandReceiptsAfterTwenty();
});
