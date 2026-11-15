import { describe, expect, it } from 'vitest';

import { inProcess } from './support/in-process.js';

// Needs only the built packages, so a focused unit run catches an entry
// point that gained or lost a name.
describe('@pertexo/secrets/server as a built package', () => {
  it('names the entry point it promises', async () => {
    const names = await inProcess(`
      const entry = await import('@pertexo/secrets/server');
      console.log(JSON.stringify(Object.keys(entry).sort()));
    `);

    expect(names).toEqual([
      'ApplicationKeyConfigurationError',
      'ApplicationSecretKeyUnavailableError',
      'AwsKmsEnvelopeKeyProvider',
      'AwsKmsWebhookEnvelopeKeyProvider',
      'CALLBACK_DEVELOPMENT_KEY',
      'ConnectionEnvelopeEncryption',
      'ConnectionSecretEncryptionError',
      'NodeDnsResolver',
      'NodeHttpTransport',
      'SECURE_HTTP_ERROR_CODE',
      'SECURITY_NOTICE_VALIDITY_MILLIS',
      'SYSTEM_MAIL_DELIVERY_BUDGET',
      'SYSTEM_MAIL_FAILURE_GUIDANCE',
      'SecureHttpClient',
      'SecureHttpError',
      'StoredKeyVerificationError',
      'SystemMailConfigurationError',
      'WebhookTriggerEnvelopeEncryption',
      'WebhookTriggerSecretEncryptionError',
      'applicationKeyVersionSchema',
      'applicationSealedSecretSchema',
      'authenticationMailAssociatedData',
      'callbackTokenHash',
      'connectionSecretAssociatedData',
      'createApplicationSecretEnvelope',
      'createAwsConnectionEnvelopeEncryption',
      'createAwsWebhookTriggerEnvelopeEncryption',
      'createCallbackTokenKeys',
      'createConnectionEnvelopeEncryption',
      'createEncryptionKeyRepository',
      'createNodeSecureHttpClient',
      'createSmtpClient',
      'createSystemMailDeliveryHandler',
      'createSystemMailDeliveryStore',
      'createSystemMailEnqueueStore',
      'createWebhookTriggerEnvelopeEncryption',
      'insertSystemMail',
      'inspectSecureHttpError',
      'isAllowedPrivateAddress',
      'normalizeUrlHostname',
      'parseAllowedPrivateNetworks',
      'parseApplicationPreviousKeys',
      'parseCallbackKeyConfig',
      'parseConnectionEncryptionConfig',
      'parseSystemMailConfig',
      'redactText',
      'systemMailFailureCode',
      'systemMailFailureInstruction',
      'validateApplicationKeyRing',
      'verifyCallbackTokenKeys',
      'verifyStoredEncryptionKeys',
      'verifySystemMailKeys',
      'webhookTriggerSecretAssociatedData',
    ]);
  });

  it('has no root entry point', async () => {
    await expect(
      inProcess(`await import('@pertexo/secrets');`),
    ).rejects.toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main/u);
  });

  it('took its names out of the database platform entry point', async () => {
    const names = (await inProcess(`
      const entry = await import('@pertexo/database/platform');
      console.log(JSON.stringify(Object.keys(entry)));
    `)) as readonly string[];

    for (const moved of [
      'authenticationMailAssociatedData',
      'createEncryptionKeyRepository',
      'createSystemMailDeliveryStore',
      'createSystemMailEnqueueStore',
      'insertSystemMail',
      'verifySystemMailKeys',
    ])
      expect(names).not.toContain(moved);
  });
});
