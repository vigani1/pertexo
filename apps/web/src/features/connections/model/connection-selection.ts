import type {
  ConnectionFormDefinition,
  ConnectionResponse,
} from '@pertexo/contracts';

export function fitsRequirement(
  connection: Pick<ConnectionResponse, 'providerKey' | 'authType'>,
  requirement: string,
  definitions: readonly ConnectionFormDefinition[],
): boolean {
  return definitions.some(
    (entry) =>
      entry.slot === requirement &&
      entry.providerKey === connection.providerKey &&
      entry.authType === connection.authType,
  );
}

export function isUsableConnection(
  connection: Pick<ConnectionResponse, 'providerKey' | 'authType' | 'status'>,
  requirement: string,
  definitions: readonly ConnectionFormDefinition[],
): boolean {
  return (
    connection.status === 'active' &&
    fitsRequirement(connection, requirement, definitions)
  );
}
