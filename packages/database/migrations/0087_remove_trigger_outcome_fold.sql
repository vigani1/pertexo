-- Core now owns completion ordering, the streak rule, pause and audit effects.
-- No caller remains; remove the old elevated rule rather than keeping two paths.
DROP FUNCTION app.fold_workflow_trigger_outcomes(integer);
