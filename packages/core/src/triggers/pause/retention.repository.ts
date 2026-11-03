import { sql } from 'drizzle-orm';
import {
  workflowTriggerFailures as failures,
  workflowFailureStreaks as streaks,
} from '@pertexo/database/schema';
import { deletionRule } from '../../lifecycle/retention/deletion-rule.js';

// Both fences only advance. A success or resume can make more rows irrelevant
// while this page waits, but can never make an irrelevant position count again.
export const TRIGGER_FAILURE_RETENTION_RULE = deletionRule(
  'workflow_trigger_failures',
  {
    table: failures,
    keys: [failures.id],
    condition: sql`exists(select 1 from ${streaks}
    where ${streaks.workspaceId}=${failures.workspaceId}
      and ${streaks.workflowId}=${failures.workflowId}
      and (${failures.endedAt}<=${streaks.resumedAfter}
        or (${failures.endedAt},${failures.id})<=(${streaks.successEndedAt},${streaks.successOutcomeId})))`,
    orderBy: [
      failures.workspaceId,
      failures.workflowId,
      failures.endedAt,
      failures.id,
    ],
  },
);
