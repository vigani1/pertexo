import { StartupSettingError } from '@pertexo/observability/startup';
import {
  parseApplicationPreviousKeys,
  parseSystemMailConfig,
  SystemMailConfigurationError,
  ApplicationKeyConfigurationError,
  createApplicationSecretEnvelope,
  type ApplicationKeyRing,
} from '@pertexo/secrets/server';

export function readMailPreviousKeys(
  setting: 'AUTH_MAIL_PREVIOUS_KEYS' | 'INVITATION_TOKEN_PREVIOUS_KEYS',
  value: string | undefined,
) {
  try {
    return parseApplicationPreviousKeys(value);
  } catch {
    throw new StartupSettingError(setting, 'previous_keys_required');
  }
}

export function createMailEnvelope(
  keys: ApplicationKeyRing,
  currentSetting: 'AUTH_MAIL_KEY' | 'INVITATION_TOKEN_KEY',
  previousSetting: 'AUTH_MAIL_PREVIOUS_KEYS' | 'INVITATION_TOKEN_PREVIOUS_KEYS',
) {
  try {
    return createApplicationSecretEnvelope(keys);
  } catch (error: unknown) {
    if (!(error instanceof ApplicationKeyConfigurationError)) throw error;
    const current = error.section === 'current';
    throw new StartupSettingError(
      current ? currentSetting : previousSetting,
      current ? 'application_key_required' : 'previous_keys_required',
    );
  }
}

export function parseMailTransport(
  environment: Readonly<Record<string, string | undefined>>,
  options: Parameters<typeof parseSystemMailConfig>[1],
) {
  try {
    return parseSystemMailConfig(environment, options);
  } catch (error: unknown) {
    if (error instanceof SystemMailConfigurationError)
      throw new StartupSettingError(error.setting, error.reason);
    throw error;
  }
}
