export type TypedMention = Readonly<{ start: number; query: string }>;

/** The "@name" being typed just before the caret, as Slack and Linear read it. */
export function typedMention(
  text: string,
  caret: number,
): TypedMention | undefined {
  const match = /(?:^|\s)@([^\s@]{0,40})$/u.exec(text.slice(0, caret));
  if (match === null) return undefined;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Replaces the typed "@na" with "@Name " and says where the caret goes. */
export function insertMention(
  text: string,
  typed: TypedMention,
  caret: number,
  name: string,
): Readonly<{ text: string; caret: number }> {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, typed.start) + inserted + text.slice(caret),
    caret: typed.start + inserted.length,
  };
}
