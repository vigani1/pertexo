import { describe, expect, it } from 'vitest';

import {
  isJourneyToken,
  newJourneyToken,
} from '../../../src/authentication/journeys/browser-proof.js';
import { CALLBACK_LIMITS } from '../../../src/authentication/journeys/callback-limits.js';

describe('journey tokens', () => {
  it('accepts a fresh journey token as the state a provider callback may carry', () => {
    const token = newJourneyToken();

    expect(isJourneyToken(token)).toBe(true);
    expect(token).toHaveLength(CALLBACK_LIMITS.stateCharacters);
  });

  it('refuses a token one character longer or shorter than a fresh one', () => {
    const token = newJourneyToken();

    expect(isJourneyToken(`${token}a`)).toBe(false);
    expect(isJourneyToken(token.slice(1))).toBe(false);
  });
});
