import {
  oauth2ClientSettingsSchema,
  type OAuth2ClientSettings,
} from '@pertexo/contracts';
export function decodeClientSettings(value: unknown): OAuth2ClientSettings {
  return oauth2ClientSettingsSchema.parse(value);
}
