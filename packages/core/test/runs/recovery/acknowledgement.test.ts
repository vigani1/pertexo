import { describe, expect, it } from 'vitest';
import {
  missingRecoveryAcknowledgement,
  recoveryEffectsAcknowledged,
} from '../../../src/runs/recovery/acknowledgement.js';

describe('recovery acknowledgements', () => {
  it('asks for the effects acknowledgement when the step may have had effects', () => {
    expect(missingRecoveryAcknowledgement('possible_effects', {})).toBe(
      'effects_acknowledgement_required',
    );
    expect(
      missingRecoveryAcknowledgement('possible_effects', {
        acknowledgeUnknownOutcome: true,
      }),
    ).toBe('effects_acknowledgement_required');
    expect(
      missingRecoveryAcknowledgement('possible_effects', {
        acknowledgePossibleEffects: true,
      }),
    ).toBeUndefined();
  });

  it('asks for the unknown-outcome acknowledgement when the outcome is unknown', () => {
    expect(
      missingRecoveryAcknowledgement('unknown_outcome', {
        acknowledgePossibleEffects: true,
      }),
    ).toBe('unknown_outcome_acknowledgement_required');
    expect(
      missingRecoveryAcknowledgement('unknown_outcome', {
        acknowledgeUnknownOutcome: true,
      }),
    ).toBeUndefined();
  });

  it('records the acknowledgement that matches the risk', () => {
    const both = {
      acknowledgePossibleEffects: false,
      acknowledgeUnknownOutcome: true,
    };
    expect(recoveryEffectsAcknowledged('unknown_outcome', both)).toBe(true);
    expect(recoveryEffectsAcknowledged('possible_effects', both)).toBe(false);
    expect(recoveryEffectsAcknowledged('ordinary', {})).toBe(false);
  });
});
