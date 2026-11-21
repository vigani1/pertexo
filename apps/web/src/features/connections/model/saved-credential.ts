import { pluralWord } from '@/lib/format/count';
import { filledRows, type CredentialDraft } from './credential-draft';

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
    case 'schema': {
      const read = (field: string) => String(draft.values[field] ?? '');
      switch (draft.definition.test) {
        case 'postgres':
          return { term: 'Database', value: read('database') };
        case 'smtp':
          return {
            term: 'SMTP',
            value: `${read('host')}:${read('port')} · sends from ${read('fromEmail')}`,
          };
        case 'slack':
          return {
            term: 'Token',
            value: maskSecret(read('botToken').trim(), 'xoxb-'),
          };
        case 'resend':
          return {
            term: 'API key',
            value: `${maskSecret(read('apiKey').trim(), 're_')} · sends from ${read('fromEmail').trim()}`,
          };
        default:
          return { term: 'Key', value: 'Stored encrypted' };
      }
    }
    case 'http': {
      const names = filledRows(draft.headers).map((row) => row.name.trim());
      return {
        term: pluralWord(names.length, 'Header'),
        value: names.join(', '),
      };
    }
    case 'oauth2':
      return { term: 'Client ID', value: draft.clientId.trim() };
  }
}
