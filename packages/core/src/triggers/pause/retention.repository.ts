import { sql } from 'drizzle-orm';
import { MAX_AUTO_PAUSE_THRESHOLD } from '@pertexo/policy';
import {
  workflowTriggerFailures as failures,
  workflowFailureStreaks as streaks,
} from '@pertexo/database/schema';
import { deletionRule } from '../../shared/retention-deletion.js';

// Fences only advance. A position with a full newer suffix is also redundant:
// a future success either leaves that suffix, or supersedes this position too.
export const TRIGGER_FAILURE_RETENTION_RULE = deletionRule(
  'workflow_trigger_failures',
  {
    table: failures,
    keys: [failures.id],
    condition: sql`exists(select 1 from ${streaks}
    where ${streaks.workspaceId}=${failures.workspaceId}
      and ${streaks.workflowId}=${failures.workflowId}
      and (${failures.endedAt}<=${streaks.resumedAfter}
        or (${failures.endedAt},${failures.id})<=(${streaks.successEndedAt},${streaks.successOutcomeId})))
      or exists(select 1 from app.workflow_trigger_failures newer
        where newer.workspace_id=${failures.workspaceId} and newer.workflow_id=${failures.workflowId}
          and (newer.ended_at,newer.id)>(${failures.endedAt},${failures.id})
        offset ${MAX_AUTO_PAUSE_THRESHOLD - 1} limit 1)`,
    orderBy: [
      failures.workspaceId,
      failures.workflowId,
      failures.endedAt,
      failures.id,
    ],
  },
);
