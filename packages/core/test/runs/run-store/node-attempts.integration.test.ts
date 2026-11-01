import { describe } from 'vitest';

import { registerLeasesAdmittedButUnstartedWork } from './node-attempts/leases/leases-admitted-but-unstarted-work.cases.js';
import { registerReconcilesDurableUnknownOutcomeEvidence } from './node-attempts/completion/reconciles-durable-unknown-outcome-evidence.cases.js';
import { registerRecordsAttemptInputUnderLive } from './node-attempts/leases/records-attempt-input-under-live.cases.js';
import { registerRollsBackFullCompletionTransaction } from './node-attempts/completion/rolls-back-full-completion-transaction.cases.js';
import { registerMatchesExecutorFailureReplayFields } from './node-attempts/completion/matches-executor-failure-replay-fields.cases.js';
import { registerClaimsOneTransportBoundReady } from './node-attempts/leases/claims-one-transport-bound-ready.cases.js';
import { registerCommitsReplaysOneExactTerminal } from './node-attempts/completion/commits-replays-one-exact-terminal.cases.js';
import { registerLoadsImmutablePersistedUpstreamValue } from './node-attempts/reads/loads-immutable-persisted-upstream-value.cases.js';
import { registerKeepsHTTPSlackDispatchMarkers } from './node-attempts/dispatch/keeps-httpslack-dispatch-markers.cases.js';
import { registerAtomicallySuspendsAttemptDatabaseTime } from './node-attempts/controls/atomically-suspends-attempt-database-time.cases.js';
import { registerLetsOperatorRecordCommandsReplays } from './node-attempts/controls/lets-operator-record-commands-replays.cases.js';
import { registerReportsAbortControlOnce } from './node-attempts/controls/reports-abort-control-once.cases.js';
describe('Coordinator node-attempt persistence invariants', () => {
  registerLeasesAdmittedButUnstartedWork();

  registerReconcilesDurableUnknownOutcomeEvidence();

  registerRecordsAttemptInputUnderLive();

  registerRollsBackFullCompletionTransaction();

  registerMatchesExecutorFailureReplayFields();

  registerClaimsOneTransportBoundReady();

  registerCommitsReplaysOneExactTerminal();

  registerLoadsImmutablePersistedUpstreamValue();

  registerKeepsHTTPSlackDispatchMarkers();

  registerAtomicallySuspendsAttemptDatabaseTime();

  registerLetsOperatorRecordCommandsReplays();

  registerReportsAbortControlOnce();
});
