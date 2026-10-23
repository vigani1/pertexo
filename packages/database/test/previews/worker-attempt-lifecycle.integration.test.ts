import { describe } from 'vitest';

import { registerRetainsPrivateCodeDiagnosticsUnder } from './worker-attempt-lifecycle/retains-private-code-diagnostics-under.cases.js';
import { registerClaimsQueuedAttemptPinnedIdentity } from './worker-attempt-lifecycle/claims-queued-attempt-pinned-identity.cases.js';
import { registerRejectsChangedTerminalReplayValues } from './worker-attempt-lifecycle/rejects-changed-terminal-replay-values.cases.js';
import { registerFencesStaleWorkersHeartbeatsCurrent } from './worker-attempt-lifecycle/fences-stale-workers-heartbeats-current.cases.js';
import { registerBoundsClaimOwnershipByImmutable } from './worker-attempt-lifecycle/bounds-claim-ownership-by-immutable.cases.js';
describe('preview worker attempt lifecycle', () => {
  registerRetainsPrivateCodeDiagnosticsUnder();

  registerClaimsQueuedAttemptPinnedIdentity();

  registerRejectsChangedTerminalReplayValues();

  registerFencesStaleWorkersHeartbeatsCurrent();

  registerBoundsClaimOwnershipByImmutable();
});
