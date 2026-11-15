import type { ApiClient } from '@/lib/api/client';
import {
  disableTwoFactor,
  enableTwoFactor,
  regenerateRecoveryCodes,
} from './two-factor.api';

export type TwoFactorAction = 'enable' | 'regenerate' | 'disable';
export type TwoFactorOutcome =
  | Readonly<{ kind: 'enabled'; uri: string; codes: readonly string[] }>
  | Readonly<{ kind: 'regenerated'; codes: readonly string[] }>
  | Readonly<{ kind: 'disabled' }>;

/** Runs one authenticator change, confirmed by the account password. */
export async function changeTwoFactor(
  apiClient: ApiClient,
  action: TwoFactorAction,
  password: string,
  signal: AbortSignal,
): Promise<TwoFactorOutcome> {
  if (action === 'enable') {
    const result = await enableTwoFactor(apiClient, password, signal);
    return { kind: 'enabled', uri: result.totpURI, codes: result.backupCodes };
  }
  if (action === 'regenerate') {
    const result = await regenerateRecoveryCodes(apiClient, password, signal);
    return { kind: 'regenerated', codes: result.backupCodes };
  }
  await disableTwoFactor(apiClient, password, signal);
  return { kind: 'disabled' };
}
