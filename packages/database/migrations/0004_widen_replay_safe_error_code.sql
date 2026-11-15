-- An operator replay's safe error code widens from 64 to the 128 characters
-- every other safe error code has (NODE_FAILURE_FIELD_LIMITS). No row is
-- rewritten; the table is locked and scanned once to recheck its CHECK.

ALTER TABLE "app"."operator_run_replay_requests" ALTER COLUMN "safe_error_code" SET DATA TYPE varchar(128);
