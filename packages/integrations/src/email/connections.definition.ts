import {
  EMAIL_ADDRESS_LIMITS,
  RESOURCE_NAME_MAX_LENGTH,
} from '@pertexo/workflow-model';
import {
  CONNECTION_CREDENTIALS_BOUNDS,
  resendApiKeyCredentialSchema,
  smtpCredentialSchema,
} from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';
import { labelledChoice } from '@pertexo/node-sdk';

const SMTP_DEFAULT_PORT = 587;
const RESEND_EMAIL_INPUT_CHARACTERS = 512;

export const resendSuccessSchema = z.object({ id: z.uuid() }).strip();

const resendFields = {
  apiKey: resendApiKeyCredentialSchema.unwrap().shape.apiKey.meta({
    title: 'Resend API key',
    help: [
      'Open resend.com/api-keys and create an API key.',
      'Give it Sending access. Full access isn’t needed.',
      'Copy the key. It starts with re_ and is only shown once.',
      'Use a from address on a domain you verified in Resend.',
    ],
    blankError: 'Paste an API key from Resend.',
    invalidError: 'Resend API keys start with re_.',
    serverError: 'Resend didn’t accept this API key format.',
    trim: true,
    placeholder: 're_…',
    secret: true,
    inputMaxLength: CONNECTION_CREDENTIALS_BOUNDS.apiKeyCharacters,
  }),
  fromEmail: resendApiKeyCredentialSchema.unwrap().shape.fromEmail.meta({
    title: 'From address',
    trim: true,
    placeholder: 'alerts@yourdomain.com',
    format: 'email',
    validateAs: 'mailbox',
    blankError:
      'Enter the address emails come from, like alerts@yourdomain.com.',
    invalidError:
      'That isn’t a complete email address, like alerts@yourdomain.com.',
    serverError: 'Use a complete email address, like alerts@yourdomain.com.',
    inputMaxLength: RESEND_EMAIL_INPUT_CHARACTERS,
    description:
      'Emails come from this address. Its domain must be verified in Resend.',
  }),
};

export const RESEND_API_KEY_CONNECTION = {
  authType: 'resend_api_key',
  presentation: {
    requirement: 'Email · Resend connection',
    choice: 'email',
    pickerOrder: 3,
    name: 'Email · Resend',
    purpose: 'Send notification email',
    credential: 'API key',
    savedCredential: 'Resend API key',
    usedBy: 'Send email steps and email alerts',
    nameSuffix: 'email',
    variant: 'Resend',
    maskedSummary: {
      field: 'apiKey',
      label: 'API key',
      prefix: 're_',
      senderField: 'fromEmail',
    },
    testCopy: {
      name: 'Resend',
      credential: 'key',
      rejectionHelp:
        'Create a new sending key in Resend and check the from address uses a verified domain.',
      consentDetail:
        'Resend delivers it to its own test inbox and counts it toward your Resend usage.',
    },
    variantPrompt: 'Send email with',
  },
  schema: resendApiKeyCredentialSchema
    .unwrap()
    .safeExtend(resendFields)
    .readonly(),
  fields: z.strictObject(resendFields),
  auth: { kind: 'bearer', field: 'apiKey' },
  test: {
    kind: 'http',
    method: 'POST',
    target: 'https://api.resend.com/emails',
    requiresConsent: true,
    consentMessage:
      'This connection uses Resend. Accept its test email before testing.',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
    },
    body: {
      fields: {
        to: ['delivered@resend.dev'],
        subject: 'Pertexo Resend connection test',
        text: 'This message verifies a Pertexo Resend sending connection.',
      },
      credentialFields: { from: 'fromEmail' },
      idempotencyHeader: 'idempotency-key',
    },
    success: {
      status: '2xx',
      reportStatus: 200,
      json: { schema: resendSuccessSchema },
    },
  },
  slot: { key: 'resend_api_key', primary: true },
} as const satisfies ConnectionDefinition;

const smtpFields = {
  host: smtpCredentialSchema.unwrap().shape.host.meta({
    type: 'string',
    title: 'SMTP host',
    trim: true,
    inputMaxLength: CONNECTION_CREDENTIALS_BOUNDS.hostCharacters,
  }),
  port: smtpCredentialSchema.unwrap().shape.port.meta({
    title: 'Port',
    default: SMTP_DEFAULT_PORT,
    inputMaxLength: String(CONNECTION_CREDENTIALS_BOUNDS.portMaximum).length,
  }),
  username: smtpCredentialSchema.unwrap().shape.username.meta({
    title: 'Username',
    inputMaxLength: CONNECTION_CREDENTIALS_BOUNDS.usernameCharacters,
  }),
  password: smtpCredentialSchema.unwrap().shape.password.meta({
    title: 'Password',
    secret: true,
    inputMaxLength: CONNECTION_CREDENTIALS_BOUNDS.passwordCharacters,
  }),
  fromEmail: smtpCredentialSchema.unwrap().shape.fromEmail.meta({
    title: 'From address',
    trim: true,
    validateAs: 'mailbox',
    inputMaxLength: EMAIL_ADDRESS_LIMITS.newAddressCharacters,
  }),
  fromName: smtpCredentialSchema.unwrap().shape.fromName.meta({
    title: 'From name (optional)',
    trim: true,
    omitEmpty: true,
    inputMaxLength: RESOURCE_NAME_MAX_LENGTH,
  }),
  security: labelledChoice({
    implicit: 'Implicit TLS',
    starttls: 'STARTTLS required',
    none: 'None',
  }).meta({ title: 'Security', notice: 'smtp_plaintext', default: 'starttls' }),
};

export const SMTP_CONNECTION = {
  authType: 'smtp',
  presentation: {
    choice: 'smtp',
    pickerOrder: 4,
    name: 'Email (SMTP)',
    purpose: 'Send email through an SMTP relay',
    credential: 'SMTP login',
    savedCredential: 'SMTP',
    usedBy: 'Send email steps and email alerts',
    nameSuffix: 'SMTP',
    testCopy: { rejectionReason: 'invalid API key' },
    variant: 'SMTP',
    variantPrompt: 'Send email with',
  },
  schema: smtpCredentialSchema.unwrap().safeExtend(smtpFields).readonly(),
  fields: z.strictObject(smtpFields),
  auth: { kind: 'smtp' },
  test: { kind: 'smtp', automatic: true },
  slot: { key: 'resend_api_key', primary: false },
} as const satisfies ConnectionDefinition;
