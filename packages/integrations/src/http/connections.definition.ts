import {
  httpHeadersCredentialSchema,
  oauth2CredentialSchema,
} from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';

export const HTTP_HEADERS_CONNECTION = {
  authType: 'http_headers',
  presentation: {
    requirement: 'HTTP connection',
    choice: 'http',
    pickerOrder: 2,
    name: 'HTTP',
    purpose: 'Call any API with headers or OAuth2',
    credential: 'headers',
    savedCredential: 'headers',
    usedBy: 'HTTP request steps',
    nameSuffix: 'API',
    variant: 'Headers',
    variantPrompt: 'How this connection signs in',
  },
  schema: httpHeadersCredentialSchema,
  fields: z.strictObject({
    headers: z
      .record(z.string(), z.string().meta({ secret: true }))
      .meta({ title: 'Headers' }),
  }),
  auth: { kind: 'header_map', field: 'headers' },
  test: {
    kind: 'http',
    method: 'GET',
    target: 'entered_url',
    success: { status: '2xx' },
  },
  slot: { key: 'http_headers', primary: true },
} as const satisfies ConnectionDefinition;

const oauth2Fields = {
  clientSecret: oauth2CredentialSchema
    .unwrap()
    .shape.clientSecret.meta({ title: 'Client secret', secret: true }),
};

const OAUTH2_PRESETS = [
  {
    key: 'google',
    label: 'Google',
    values: {
      grantType: 'authorization_code',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/userinfo.email',
      clientAuthentication: 'body',
      pkce: 's256',
      // Without these Google gives no refresh token, and the connection stops
      // working after an hour.
      authorizationParameters: 'access_type=offline\nprompt=consent',
      tokenParameters: '',
      hostMode: 'listed',
      hosts: '*.googleapis.com',
    },
  },
  {
    key: 'microsoft',
    label: 'Microsoft',
    values: {
      grantType: 'authorization_code',
      authorizationUrl:
        'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scope: 'offline_access https://graph.microsoft.com/User.Read',
      clientAuthentication: 'body',
      pkce: 's256',
      authorizationParameters: '',
      tokenParameters: '',
      hostMode: 'listed',
      hosts: 'graph.microsoft.com',
    },
  },
] as const;

export const OAUTH2_CONNECTION = {
  authType: 'oauth2',
  presets: OAUTH2_PRESETS,
  presentation: {
    choice: 'http',
    name: 'HTTP',
    purpose: 'Call any API with headers or OAuth2',
    credential: 'headers',
    savedCredential: 'OAuth2',
    usedBy: 'HTTP request steps',
    nameSuffix: 'API',
    variant: 'OAuth2',
    variantPrompt: 'How this connection signs in',
  },
  schema: oauth2CredentialSchema.unwrap().safeExtend(oauth2Fields).readonly(),
  fields: z.strictObject(oauth2Fields),
  auth: { kind: 'oauth2' },
  test: { kind: 'oauth2', method: 'GET', target: 'entered_url' },
  slot: { key: 'http_headers', primary: false },
} as const satisfies ConnectionDefinition;
