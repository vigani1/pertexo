import type {
  WorkflowRecoveryEffectRisk,
  WorkflowRecoveryRefusal,
} from '@pertexo/workflow-model';

export type RecoveryAcknowledgements = Readonly<{
  acknowledgePossibleEffects?: boolean | undefined;
  acknowledgeUnknownOutcome?: boolean | undefined;
}>;

/** A risky recovery needs the acknowledgement that names its risk. */
export function missingRecoveryAcknowledgement(
  effectRisk: WorkflowRecoveryEffectRisk,
  acknowledgements: RecoveryAcknowledgements,
): WorkflowRecoveryRefusal | undefined {
  if (
    effectRisk === 'possible_effects' &&
    !(acknowledgements.acknowledgePossibleEffects ?? false)
  )
    return 'effects_acknowledgement_required';
  if (
    effectRisk === 'unknown_outcome' &&
    !(acknowledgements.acknowledgeUnknownOutcome ?? false)
  )
    return 'unknown_outcome_acknowledgement_required';
  return undefined;
}

/** The acknowledgement recorded with the run is the one its risk asks for. */
export function recoveryEffectsAcknowledged(
  effectRisk: WorkflowRecoveryEffectRisk,
  acknowledgements: RecoveryAcknowledgements,
): boolean {
  return effectRisk === 'unknown_outcome'
    ? (acknowledgements.acknowledgeUnknownOutcome ?? false)
    : (acknowledgements.acknowledgePossibleEffects ?? false);
}
