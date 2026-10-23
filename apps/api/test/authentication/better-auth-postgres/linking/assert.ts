import { expect } from 'vitest';

import type { callbackOrderings } from './contract.js';
import { createProviderLinkScenario } from './context.js';
import { createVerifiedLinkingBrowser, startProviderLink } from './browser.js';
import { dispatchProviderLinkCallbacks } from './callbacks.js';
import { assertProviderLinkResult } from './result.js';
import { linkSecondProvider } from './second.js';

export async function assertSingleProviderLink(
  ordering: (typeof callbackOrderings)[number],
  firstCallbackFailure?: 'early-return' | 'early-rejection',
): Promise<void> {
  const browser = await createVerifiedLinkingBrowser();
  const scenario = createProviderLinkScenario(browser);
  try {
    const started = await startProviderLink(scenario);
    const callbacks = await dispatchProviderLinkCallbacks({
      scenario,
      started,
      ordering,
      firstCallbackFailure,
    });
    const { first, authenticationCalls } = callbacks;
    if (firstCallbackFailure === 'early-return') {
      expect(first.status).toBe(401);
      expect(authenticationCalls).toBe(1);
      return;
    }

    const replacementCookie = await assertProviderLinkResult({
      scenario,
      started,
      callbacks,
      ordering,
    });
    await linkSecondProvider(scenario, replacementCookie);
  } finally {
    await scenario.linkingRuntime.close();
  }
}
