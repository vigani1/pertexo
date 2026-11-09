import { expect, it } from 'vitest';
import { parseApiConfig } from '../../src/platform/config/api-config.js';
const environment = {
  DATABASE_MAINTENANCE_URL:
    'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
  DATABASE_URL: 'postgresql://pertexo_app:fixture@localhost:5432/pertexo',
};

it('requires an explicit operator opt-in for unencrypted SMTP', () => {
  expect(parseApiConfig(environment).smtpAllowPlaintext).toBe(false);
  expect(
    parseApiConfig({ ...environment, SMTP_ALLOW_PLAINTEXT: 'true' })
      .smtpAllowPlaintext,
  ).toBe(true);
  expect(
    parseApiConfig({ ...environment, SMTP_ALLOW_PLAINTEXT: 'false' })
      .smtpAllowPlaintext,
  ).toBe(false);
  expect(() =>
    parseApiConfig({ ...environment, SMTP_ALLOW_PLAINTEXT: 'sometimes' }),
  ).toThrow(/SMTP_ALLOW_PLAINTEXT/u);
});
