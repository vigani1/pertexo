import type { createProviderLinkScenario } from './context.js';
import type { startProviderLink } from './browser.js';
import type { dispatchProviderLinkCallbacks } from './callbacks.js';

export const callbackOrderings = [
  'uncontrolled callbacks',
  'loser authentication after commit',
  'both provider proofs before commit',
] as const;

export type ProviderLinkScenario = ReturnType<
  typeof createProviderLinkScenario
>;

export type ProviderLinkStart = Awaited<ReturnType<typeof startProviderLink>>;

export type ProviderLinkCallbacks = Awaited<
  ReturnType<typeof dispatchProviderLinkCallbacks>
>;

export type CallbackOrdering = (typeof callbackOrderings)[number];

export type CallbackFailure = 'early-return' | 'early-rejection';
