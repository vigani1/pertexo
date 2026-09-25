import {
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
  type ConnectionCreateRequest,
} from '@pertexo/contracts/schemas/connections';
import type { ApiProblemIssue } from '@pertexo/contracts/schemas/errors';
import type { FieldErrors } from '@/components/ui/use-field-validation';
import type { ConnectionCredential } from '../connections.api';
import type { ProviderKey } from './connection-providers';

export type HeaderRow = Readonly<{ id: string; name: string; value: string }>;

/** Unsaved credential input. It lives only in the form that owns it. */
export type CredentialDraft =
  | Readonly<{ provider: 'slack'; botToken: string }>
  | Readonly<{ provider: 'http'; headers: readonly HeaderRow[] }>
  | Readonly<{ provider: 'email'; apiKey: string; fromEmail: string }>;

export type CredentialField =
  | 'botToken'
  | 'apiKey'
  | 'fromEmail'
  | 'headers'
  | `header-name:${string}`
  | `header-value:${string}`;

export const MAX_HEADER_ROWS = 32;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const PLACEHOLDER_RESEND_KEY = 're_placeholder';
const SLACK_TOKEN_FORMAT =
  'Slack bot tokens start with xoxb- and use only letters, numbers and dashes.';

export function emptyCredentialDraft(
  provider: ProviderKey,
  createId: () => string,
): CredentialDraft {
  switch (provider) {
    case 'slack':
      return { provider, botToken: '' };
    case 'http':
      return {
        provider,
        headers: [{ id: createId(), name: 'Authorization', value: '' }],
      };
    case 'email':
      return { provider, apiKey: '', fromEmail: '' };
  }
}

function slackTokenError(botToken: string): string | undefined {
  const token = botToken.trim();
  if (token === '') return 'Paste the bot token from your Slack app.';
  return slackBotTokenCredentialSchema.safeParse({
    schemaVersion: 1,
    type: 'slack_bot_token',
    botToken: token,
  }).success
    ? undefined
    : SLACK_TOKEN_FORMAT;
}

function resendKeyError(apiKey: string): string | undefined {
  const key = apiKey.trim();
  if (key === '') return 'Paste an API key from Resend.';
  return /^re_[A-Za-z0-9_-]{5,}$/u.test(key)
    ? undefined
    : 'Resend API keys start with re_.';
}

function fromEmailError(fromEmail: string): string | undefined {
  const email = fromEmail.trim();
  if (email === '')
    return 'Enter the address emails come from, like alerts@yourdomain.com.';
  return resendApiKeyCredentialSchema.safeParse({
    schemaVersion: 1,
    type: 'resend_api_key',
    apiKey: PLACEHOLDER_RESEND_KEY,
    fromEmail: email,
  }).success
    ? undefined
    : 'That isn’t a complete email address, like alerts@yourdomain.com.';
}

function filledRows(headers: readonly HeaderRow[]): readonly HeaderRow[] {
  return headers.filter(
    (row) => row.name.trim() !== '' || row.value.trim() !== '',
  );
}

function headerRowErrors(
  headers: readonly HeaderRow[],
): Partial<Record<CredentialField, string>> {
  const errors: Partial<Record<CredentialField, string>> = {};
  const rows = filledRows(headers);
  const first = headers[0];
  if (rows.length === 0 && first !== undefined) {
    errors[`header-name:${first.id}`] =
      'Add at least one header, like Authorization.';
    return errors;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '') errors[`header-name:${row.id}`] = 'Name this header.';
    else if (!HEADER_NAME.test(name))
      errors[`header-name:${row.id}`] =
        'Header names use letters, numbers and dashes, without spaces.';
    else if (seen.has(name.toLowerCase()))
      errors[`header-name:${row.id}`] = 'This header is already listed.';
    seen.add(name.toLowerCase());
    if (row.value.trim() === '')
      errors[`header-value:${row.id}`] = 'Enter this header’s value.';
  }
  return errors;
}

function contractHeaderErrors(
  headers: readonly HeaderRow[],
): Partial<Record<CredentialField, string>> {
  const rows = filledRows(headers);
  const parsed = httpHeadersCredentialSchema.safeParse({
    schemaVersion: 1,
    type: 'http_headers',
    headers: Object.fromEntries(
      rows.map((row) => [row.name.trim(), row.value.trim()]),
    ),
  });
  if (parsed.success) return {};
  return headerIssueErrors(
    rows,
    parsed.error.issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    })),
  );
}

function headerIssueErrors(
  rows: readonly HeaderRow[],
  issues: readonly Readonly<{ path: readonly string[]; message: string }>[],
): Partial<Record<CredentialField, string>> {
  const errors: Partial<Record<CredentialField, string>> = {};
  for (const issue of issues) {
    const headerIndex = issue.path.indexOf('headers');
    const headerName = issue.path[headerIndex + 1];
    const row = rows.find(
      (candidate) =>
        candidate.name.trim().toLowerCase() === headerName?.toLowerCase(),
    );
    if (row === undefined) {
      errors.headers =
        'These headers are too large together. Remove some or shorten their values.';
    } else if (issue.message.includes('transport')) {
      errors[`header-name:${row.id}`] =
        'Pertexo sets this header itself. Use a different one.';
    } else if (issue.message.includes('unique')) {
      errors[`header-name:${row.id}`] = 'This header is already listed.';
    } else {
      errors[`header-value:${row.id}`] =
        'This value has characters HTTP can’t send.';
    }
  }
  return errors;
}

/** Every message for the draft, keyed by field. Empty when it can be saved. */
export function credentialErrors(
  draft: CredentialDraft,
): FieldErrors<CredentialField> {
  switch (draft.provider) {
    case 'slack': {
      const botToken = slackTokenError(draft.botToken);
      return botToken === undefined ? {} : { botToken };
    }
    case 'email': {
      const apiKey = resendKeyError(draft.apiKey);
      const fromEmail = fromEmailError(draft.fromEmail);
      return {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(fromEmail === undefined ? {} : { fromEmail }),
      };
    }
    case 'http': {
      const rowErrors = headerRowErrors(draft.headers);
      return Object.keys(rowErrors).length > 0
        ? rowErrors
        : contractHeaderErrors(draft.headers);
    }
  }
}

/** The contract credential for a draft that has no errors. */
export function toConnectionCredential(
  draft: CredentialDraft,
): ConnectionCredential {
  switch (draft.provider) {
    case 'slack':
      return {
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: draft.botToken.trim(),
      };
    case 'email':
      return {
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: draft.apiKey.trim(),
        fromEmail: draft.fromEmail.trim(),
      };
    case 'http':
      return {
        schemaVersion: 1,
        type: 'http_headers',
        headers: Object.fromEntries(
          filledRows(draft.headers).map((row) => [
            row.name.trim(),
            row.value.trim(),
          ]),
        ),
      };
  }
}

/** The create request for a named, valid draft. */
export function toCreateRequest(
  name: string,
  draft: CredentialDraft,
): ConnectionCreateRequest {
  const credential = toConnectionCredential(draft);
  switch (credential.type) {
    case 'slack_bot_token':
      return { providerKey: 'slack', name, credential };
    case 'resend_api_key':
      return { providerKey: 'email', name, credential };
    case 'http_headers':
      return { providerKey: 'http', name, credential };
  }
}

/** Server field issues (`credential.botToken`, …) placed on their fields. */
export function credentialServerErrors(
  draft: CredentialDraft,
  issues: readonly ApiProblemIssue[],
): FieldErrors<CredentialField> {
  const errors: Partial<Record<CredentialField, string>> = {};
  for (const issue of issues) {
    const path = issue.path.split('.');
    if (path[0] !== 'credential') continue;
    const field = path[1];
    if (draft.provider === 'slack' && field === 'botToken')
      errors.botToken = SLACK_TOKEN_FORMAT;
    else if (draft.provider === 'email' && field === 'apiKey')
      errors.apiKey = 'Resend didn’t accept this API key format.';
    else if (draft.provider === 'email' && field === 'fromEmail')
      errors.fromEmail =
        'Use a complete email address, like alerts@yourdomain.com.';
    else if (draft.provider === 'http' && field === 'headers')
      Object.assign(
        errors,
        headerIssueErrors(filledRows(draft.headers), [
          { path: path.slice(1), message: issue.message },
        ]),
      );
  }
  return errors;
}

function maskSecret(secret: string, knownPrefix: string): string {
  const prefix = secret.startsWith(knownPrefix) ? knownPrefix : '';
  return `${prefix}••••••••${secret.slice(-4)}`;
}

export type SavedCredential = Readonly<{ term: string; value: string }>;

/**
 * The credential as the add flow's summary shows it once saved: masked to
 * its known prefix and last four characters, header names without values.
 */
export function describeSavedCredential(
  draft: CredentialDraft,
): SavedCredential {
  switch (draft.provider) {
    case 'slack':
      return {
        term: 'Token',
        value: maskSecret(draft.botToken.trim(), 'xoxb-'),
      };
    case 'email':
      return {
        term: 'API key',
        value: `${maskSecret(draft.apiKey.trim(), 're_')} · sends from ${draft.fromEmail.trim()}`,
      };
    case 'http': {
      const names = filledRows(draft.headers).map((row) => row.name.trim());
      return {
        term: names.length === 1 ? 'Header' : 'Headers',
        value: names.join(', '),
      };
    }
  }
}
