import type { WorkspaceVariableValues } from './contract.js';
export function lookupWorkspaceVariable(
  name: string,
  values: WorkspaceVariableValues,
):
  | Readonly<{ kind: 'value'; value: string | number | boolean }>
  | Readonly<{ kind: 'error'; code: 'variable_missing'; message: string }> {
  const value = Object.hasOwn(values, name) ? values[name] : undefined;
  return value === undefined
    ? {
        kind: 'error',
        code: 'variable_missing',
        message: `Workspace variable ${name} is missing. Add it in Variables or update this mapping.`,
      }
    : { kind: 'value', value };
}
