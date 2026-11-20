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
    case 'smtp':
      return {
        term: 'SMTP',
        value: `${draft.host}:${draft.port} · sends from ${draft.fromEmail}`,
      };
    case 'signing':
      return { term: 'Key', value: 'Stored encrypted' };
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
        term: pluralWord(names.length, 'Header'),
        value: names.join(', '),
      };
    }
    case 'oauth2':
      return { term: 'Client ID', value: draft.clientId.trim() };
  }
}
