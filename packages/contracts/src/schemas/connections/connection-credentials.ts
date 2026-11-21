import { signingKeyCredentialSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import {
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
  smtpCredentialSchema,
} from './credential-formats.js';
import { postgresCredentialSchema } from './postgres.js';
import { oauth2CredentialSchema } from './oauth2-connections.js';

export {
  CONNECTION_CREDENTIALS_BOUNDS,
  emailMailboxSchema,
  httpHeaderCredentialSchema,
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
  smtpCredentialSchema,
} from './credential-formats.js';

export const connectionCredentialSchema = z.discriminatedUnion('type', [
  signingKeyCredentialSchema,
  httpHeadersCredentialSchema,
  slackBotTokenCredentialSchema,
  resendApiKeyCredentialSchema,
  smtpCredentialSchema,
  postgresCredentialSchema,
  oauth2CredentialSchema,
]);

export type ParsedConnectionCredential = z.output<
  typeof connectionCredentialSchema
>;
