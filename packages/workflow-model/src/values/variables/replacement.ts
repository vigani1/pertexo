import type { WorkspaceVariableValues } from './contract.js';

/** Omitted metadata retains descriptions only for names in the replacement. */
export function planWorkspaceVariableReplacement(
  current: Readonly<{
    values: WorkspaceVariableValues;
    descriptions: Readonly<Record<string, string>>;
  }>,
  input: Readonly<{
    values: WorkspaceVariableValues;
    descriptions?: Readonly<Record<string, string>> | undefined;
  }>,
) {
  const descriptions: Record<string, string> = {};
  for (const [name, description] of Object.entries(
    input.descriptions ?? current.descriptions,
  ))
    if (Object.hasOwn(input.values, name) && description !== '')
      descriptions[name] = description;
  const changedNames = [
    ...new Set([...Object.keys(current.values), ...Object.keys(input.values)]),
  ]
    .sort()
    .filter(
      (name) =>
        !Object.is(current.values[name], input.values[name]) ||
        current.descriptions[name] !== descriptions[name],
    );
  return { descriptions, changedNames };
}
