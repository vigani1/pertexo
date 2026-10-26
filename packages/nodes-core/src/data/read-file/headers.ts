import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import { FileInputFailure } from '@pertexo/node-sdk/server';

/** CSV and Excel share one header rule: nonblank, unique and untrimmed. */
export function admitHeaders(names: readonly string[]): readonly string[] {
  if (names.length > NODE_JSON_LIMITS.members)
    throw new FileInputFailure({ reason: 'value_size' });
  const unique = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (name.trim() === '')
      throw new FileInputFailure({ reason: 'blank_header', column: index + 1 });
    if (unique.has(name))
      throw new FileInputFailure({
        reason: 'duplicate_header',
        column: index + 1,
      });
    unique.add(name);
  }
  return names;
}
