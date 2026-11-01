import { describe } from 'vitest';

import { registerRejectsLegacyPrimarySlotInstead } from './run/rejects-legacy-primary-slot-instead.cases.js';
import { registerSBeforeDispatchForbidsEvidence } from './run/sbefore-dispatch-forbids-evidence.cases.js';
import { registerRejectsStaleLeasesUnmarkedDispatch } from './run/rejects-stale-leases-unmarked-dispatch.cases.js';
describe('durable revision-fenced Slack run health (ADR059)', () => {
  registerRejectsLegacyPrimarySlotInstead();

  registerSBeforeDispatchForbidsEvidence();

  registerRejectsStaleLeasesUnmarkedDispatch();
});
