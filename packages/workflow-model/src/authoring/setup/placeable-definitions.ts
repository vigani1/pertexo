import type { CodeSettings } from '@pertexo/node-sdk';

type Definition = Readonly<{
  definition: Readonly<{ key: string; version: number }>;
  presentation?:
    | Readonly<{
        community?:
          | Readonly<{ publisher: string; retained?: boolean | undefined }>
          | undefined;
      }>
    | undefined;
}>;

/** Select the latest placeable version per step type, in catalog order. */
export function placeableDefinitions<Item extends Definition>(
  definitions: readonly Item[],
  codeSettings?: Pick<CodeSettings, 'enabled'>,
): readonly Item[] {
  const chosen = new Map<string, Item>();
  for (const item of definitions) {
    const { key, version } = item.definition;
    if (
      item.presentation?.community?.retained ||
      (key === 'core.code' && codeSettings?.enabled === false)
    )
      continue;
    const current = chosen.get(key);
    if (current === undefined || version > current.definition.version)
      chosen.set(key, item);
  }
  return [...chosen.values()];
}
