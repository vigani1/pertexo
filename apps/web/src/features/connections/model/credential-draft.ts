import { RESOURCE_NAME_MAX_LENGTH } from '@pertexo/workflow-model';
import { SIGNING_KEY_MAX_BYTES } from '@pertexo/node-sdk';
import { formatCount } from '@/lib/format/count';
import {
  httpHeadersCredentialSchema,
  type ConnectionCreateRequest,
  type ConnectionFormDefinition,
} from '@pertexo/contracts';
import type { ApiProblemIssue } from '@pertexo/contracts';
import type { FieldErrors } from '@/components/ui/use-field-validation';
import type { ConnectionCredential } from '../data/connections.api';
import {
  credentialFields,
  emptySchemaCredential,
  parseScalarCredential,
  type SchemaCredentialDraft,
} from './schema-credential';
import {
  emptyOAuth2Draft,
  oauth2DraftErrors,
  oauth2ServerErrors,
  toOAuth2Credential,
  type OAuth2Draft,
} from './oauth2-draft';

export type HeaderRow = Readonly<{ id: string; name: string; value: string }>;

export type CredentialDraft =
  | Readonly<{ provider: 'http'; headers: readonly HeaderRow[] }>
  | OAuth2Draft
  | SchemaCredentialDraft;

export type CredentialField = string;

export const MAX_HEADER_ROWS = 32;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SLACK_TOKEN_FORMAT =
  'Slack bot tokens start with xoxb- and use only letters, numbers and dashes.';

export function credentialDraftHasSecret(draft: CredentialDraft): boolean {
  if (draft.provider === 'http')
    return draft.headers.some((row) => row.value.trim() !== '');
  if (draft.provider === 'oauth2') return draft.clientSecret.trim() !== '';
  return credentialFields(draft.definition).some(({ key, metadata }) => {
    const value = draft.values[key];
    return (
      metadata.secret === true &&
      typeof value === 'string' &&
      (metadata.trim === true ? value.trim() : value) !== ''
    );
  });
}

export function emptyCredentialDraft(
  definition: ConnectionFormDefinition,
  createId: () => string,
): CredentialDraft {
  if (definition.test === 'http') {
    return {
      provider: 'http',
      headers: [{ id: createId(), name: 'Authorization', value: '' }],
    };
  }
  if (definition.test === 'oauth2') return emptyOAuth2Draft();
  return emptySchemaCredential(definition);
}

export function filledRows(
  headers: readonly HeaderRow[],
): readonly HeaderRow[] {
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
      continue;
    }
    if (issue.message.includes('transport')) {
      errors[`header-name:${row.id}`] =
        'Pertexo sets this header itself. Use a different one.';
      continue;
    }
    if (issue.message.includes('unique')) {
      errors[`header-name:${row.id}`] = 'This header is already listed.';
      continue;
    }
    errors[`header-value:${row.id}`] =
      'This value has characters HTTP can’t send.';
  }
  return errors;
}

export function credentialErrors(
  draft: CredentialDraft,
): FieldErrors<CredentialField> {
  if (draft.provider === 'oauth2') return oauth2DraftErrors(draft);
  if (draft.provider === 'http') {
    const rowErrors = headerRowErrors(draft.headers);
    return Object.keys(rowErrors).length > 0
      ? rowErrors
      : contractHeaderErrors(draft.headers);
  }
  const parsed = parseScalarCredential(draft);
  if (parsed.success) return {};
  const errors: Partial<Record<CredentialField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string')
      errors[field] = scalarError(draft, field, issue.message);
  }
  return errors;
}

function scalarError(
  draft: SchemaCredentialDraft,
  field: string,
  message: string,
): string {
  const blank = String(draft.values[field] ?? '').trim() === '';
  switch (draft.definition.test) {
    case 'signing':
      return `Enter valid Unicode text of 1–${formatCount(SIGNING_KEY_MAX_BYTES, 'UTF-8 byte')}. Whitespace is preserved.`;
    case 'slack':
      return blank
        ? 'Paste the bot token from your Slack app.'
        : SLACK_TOKEN_FORMAT;
    case 'resend':
      if (field === 'apiKey')
        return blank
          ? 'Paste an API key from Resend.'
          : 'Resend API keys start with re_.';
      return blank
        ? 'Enter the address emails come from, like alerts@yourdomain.com.'
        : 'That isn’t a complete email address, like alerts@yourdomain.com.';
    case 'smtp':
      return SMTP_MESSAGES[field] ?? message;
    default:
      return message;
  }
}

const SMTP_MESSAGES: Readonly<Record<string, string>> = {
  host: 'Enter the SMTP hostname or IP address, without a URL or spaces.',
  port: 'Use a port from 1 to 65535.',
  security: 'Choose how this connection uses TLS.',
  username: 'Enter the SMTP username.',
  password: 'Enter the SMTP password.',
  fromEmail: 'Enter a valid sender email address.',
  fromName: `Use a sender name of at most ${formatCount(RESOURCE_NAME_MAX_LENGTH, 'character')} without line breaks.`,
};

export function toConnectionCredential(
  draft: CredentialDraft,
): ConnectionCredential | undefined {
  if (draft.provider === 'oauth2') return toOAuth2Credential(draft);
  if (draft.provider === 'http') {
    return {
      type: 'http_headers',
      headers: Object.fromEntries(
        filledRows(draft.headers).map((row) => [
          row.name.trim(),
          row.value.trim(),
        ]),
      ),
    };
  }
  const parsed = parseScalarCredential(draft);
  return parsed.success ? parsed.data : undefined;
}

export function toCreateRequest(
  name: string,
  definition: ConnectionFormDefinition,
  credential: ConnectionCredential,
): ConnectionCreateRequest {
  return { providerKey: definition.providerKey, name, credential };
}

export function credentialServerErrors(
  draft: CredentialDraft,
  issues: readonly ApiProblemIssue[],
): FieldErrors<CredentialField> {
  if (draft.provider === 'oauth2') return oauth2ServerErrors(issues);
  const errors: Partial<Record<CredentialField, string>> = {};
  for (const issue of issues) {
    const path = issue.path.replace(/^\//u, '').replaceAll('/', '.').split('.');
    const [root, field] = path;
    if (root !== 'credential' || field === undefined) continue;
    if (draft.provider === 'http') {
      if (field === 'headers')
        Object.assign(
          errors,
          headerIssueErrors(filledRows(draft.headers), [
            { path: path.slice(1), message: issue.message },
          ]),
        );
      continue;
    }
    if (!Object.hasOwn(draft.values, field)) continue;
    errors[field] = serverScalarError(draft, field, issue.message);
  }
  return errors;
}

function serverScalarError(
  draft: SchemaCredentialDraft,
  field: string,
  message: string,
) {
  switch (draft.definition.test) {
    case 'signing':
      return `Use valid Unicode text of 1–${formatCount(SIGNING_KEY_MAX_BYTES, 'UTF-8 byte')}.`;
    case 'slack':
      return SLACK_TOKEN_FORMAT;
    case 'resend':
      return field === 'apiKey'
        ? 'Resend didn’t accept this API key format.'
        : 'Use a complete email address, like alerts@yourdomain.com.';
    default:
      return message;
  }
}
