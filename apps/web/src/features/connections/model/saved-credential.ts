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
      const masked = draft.definition.presentation.maskedSummary;
      if (masked !== undefined) {
        const secret = maskSecret(read(masked.field).trim(), masked.prefix);
        return {
          term: masked.label,
          value:
            masked.senderField === undefined
              ? secret
              : `${secret} · sends from ${read(masked.senderField).trim()}`,
        };
      }
      if (draft.definition.test === 'postgres')
        return { term: 'Database', value: read('database') };
      if (draft.definition.test === 'smtp')
        return {
          term: 'SMTP',
          value: `${read('host')}:${read('port')} · sends from ${read('fromEmail')}`,
        };
      return { term: 'Key', value: 'Stored encrypted' };
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
