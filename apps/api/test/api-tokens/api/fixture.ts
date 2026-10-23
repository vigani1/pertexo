import { useBetterAuthRealApi } from '../../support/better-auth/real-api.support.js';

export function createAutomationApiFixture() {
  const api = useBetterAuthRealApi('tokens', { automationTokens: true });

  let origin: Promise<string> | undefined;

  const listen = () => (origin ??= api.listen());
  return { api, listen };
}

export function createDisabledAutomationFixture() {
  const api = useBetterAuthRealApi('tokens_disabled');
  return { api };
}
