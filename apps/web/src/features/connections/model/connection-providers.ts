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
export type ConnectionChoice = string;

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
  return connectionProviderKeySchema.safeParse(value).success;
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

/** Keep the stored provider key distinct from the picker variant in test requests. */
export function providerTestRequest(
  definition: ConnectionFormDefinition,
): ConnectionTestRequest {
  const { providerKey, test, testInput } = definition;
  if (test === 'smtp') return { providerKey, transport: 'smtp' };
  if (testInput === 'consent')
    return { providerKey, sideEffectDisclosureAccepted: true };
  return { providerKey };
}
