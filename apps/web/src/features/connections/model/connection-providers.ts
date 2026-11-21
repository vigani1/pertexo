import { RESOURCE_NAME_MAX_LENGTH } from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';
import {
  connectionProviderKeySchema,
  type ConnectionFormDefinition,
  type ConnectionResponse,
  type ConnectionTestRequest,
} from '@pertexo/contracts';

export type ProviderKey = ConnectionResponse['providerKey'];
/** A picker choice can name a credential variant within a stored provider. */
export type ConnectionChoice = ProviderKey | 'smtp';

export function connectionDefinition(
  definitions: readonly ConnectionFormDefinition[],
  choice: string | undefined,
  authType?: string,
) {
  return definitions.find((entry) =>
    authType === undefined
      ? entry.presentation.choice === choice &&
        entry.presentation.pickerOrder !== undefined
      : entry.authType === authType &&
        (entry.providerKey === choice || entry.presentation.choice === choice),
  );
}

export function isConnectionChoice(value: unknown): value is ConnectionChoice {
  return (
    value === 'smtp' || connectionProviderKeySchema.safeParse(value).success
  );
}

export function connectionPresentation(
  definitions: readonly ConnectionFormDefinition[],
  choice: string,
  authType?: string,
) {
  const definition = connectionDefinition(definitions, choice, authType);
  if (definition !== undefined) return definition.presentation;
  return {
    name: choice,
    credential: 'credential',
    savedCredential: 'credential',
    usedBy: 'Workflow steps',
    nameSuffix: choice,
  };
}

export function describeConnectionKind(
  definitions: readonly ConnectionFormDefinition[],
  choice: string,
  authType?: string,
): string {
  const provider = connectionPresentation(definitions, choice, authType);
  return `${provider.name} · ${authType === undefined ? provider.credential : provider.savedCredential}`;
}

export function connectionNameError(name: string): string | undefined {
  const value = name.trim();
  if (value === '')
    return 'Name this connection so people can pick it in steps.';
  if (value.length > RESOURCE_NAME_MAX_LENGTH)
    return `Keep the name under ${formatCount(RESOURCE_NAME_MAX_LENGTH, 'character')}.`;
  return undefined;
}

export function suggestConnectionName(
  definition: ConnectionFormDefinition | undefined,
  workspaceName: string,
): string {
  if (definition === undefined) return '';
  const noun = definition.presentation.nameSuffix;
  return `${workspaceName.slice(0, RESOURCE_NAME_MAX_LENGTH - 1 - noun.length).trim()} ${noun}`;
}

/** "Where do I find this?" steps for credentials people copy from a provider. */
export const CREDENTIAL_STEPS = {
  slack: [
    'Open api.slack.com/apps and pick your app, or create one for Pertexo.',
    'Under OAuth & Permissions, add the chat:write scope and install the app.',
    'Copy the Bot User OAuth Token. It starts with xoxb-.',
    'In Slack, invite the bot to each channel it should post in.',
  ],
  email: [
    'Open resend.com/api-keys and create an API key.',
    'Give it Sending access. Full access isn’t needed.',
    'Copy the key. It starts with re_ and is only shown once.',
    'Use a from address on a domain you verified in Resend.',
  ],
} as const satisfies Readonly<Record<'slack' | 'email', readonly string[]>>;

export function automaticTestRequest(
  key: string,
): ConnectionTestRequest | undefined {
  if (key === 'smtp') return { providerKey: 'email', transport: 'smtp' };
  if (key === 'slack' || key === 'signing') return { providerKey: key };
  return undefined;
}
