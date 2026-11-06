export const WORKFLOW_RECOVERY_LIMITS = Object.freeze({
  canonicalBytes: 1_048_576,
  storageBytes: 4_194_304,
});

export const WORKFLOW_RECOVERY_REFUSALS = [
  'source_not_failed',
  'multiple_failures',
  'version_unavailable',
  'unsupported_graph',
  'prefix_incomplete',
  'unknown_effect',
  'effects_acknowledgement_required',
  'unknown_outcome_acknowledgement_required',
  'evidence_unavailable',
  'suffix_already_executed',
  'values_expired',
  'values_missing',
  'artifact_value',
  'reuse_bounds',
  'branch_evidence_unavailable',
] as const;

export type WorkflowRecoveryRefusal =
  (typeof WORKFLOW_RECOVERY_REFUSALS)[number];
export type WorkflowRecoveryEffectRisk =
  'ordinary' | 'possible_effects' | 'unknown_outcome';
