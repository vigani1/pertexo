import { ConnectionSecretEncryptionError } from '@pertexo/integrations/server';

import {
  signingKeyCredentialSchema,
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
} from '../../types.js';

export function decodeCredential(plaintext: Uint8Array) {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
    );
    if (value !== null && typeof value === 'object' && 'type' in value) {
      if (value.type === 'hmac_key')
        return signingKeyCredentialSchema.parse(value);
      if (value.type === 'slack_bot_token')
        return slackBotTokenCredentialSchema.parse(value);
      if (value.type === 'resend_api_key')
        return resendApiKeyCredentialSchema.parse(value);
    }
    return httpHeadersCredentialSchema.parse(value);
  } catch {
    throw new ConnectionSecretEncryptionError();
  }
}
