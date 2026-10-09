-- A claimed schedule occurrence is admitted in its workspace's transaction,
-- so the eligibility check, the pause check and the claim completion run as
-- statements in TypeScript there (src/triggers/schedule-trigger-scanner.ts,
-- src/triggers/schedule-pause.ts). The cross-workspace claim, release, defer
-- and fail functions stay.

DROP FUNCTION app.schedule_claim_is_eligible(uuid, uuid);
DROP FUNCTION app.schedule_claim_workflow_paused(uuid, uuid);
DROP FUNCTION app.schedule_claim_workflow_paused(uuid, uuid, timestamp with time zone);
DROP FUNCTION app.complete_trigger_schedule_claim(uuid, uuid, uuid, timestamp with time zone, character varying, uuid, timestamp with time zone);

GRANT INSERT ON app.trigger_schedule_occurrences TO {{app_role}};
GRANT SELECT ON app.workflow_trigger_pause_periods TO {{app_role}};
