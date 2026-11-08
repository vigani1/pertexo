export type CommentDraftState = 'clean' | 'dirty' | 'saving' | 'uncertain';
export type CommentDraftChange = (
  key: string,
  state: CommentDraftState,
) => void;

type Mention = Readonly<{ userId: string }>;
export function commentDraftChanged(
  body: string,
  mentions: readonly Mention[],
  initial: Readonly<{ body: string; mentions: readonly Mention[] }> | undefined,
): boolean {
  if (body !== (initial?.body ?? '')) return true;
  const original = new Set(
    initial?.mentions.map((mention) => mention.userId) ?? [],
  );
  return (
    original.size !== mentions.length ||
    mentions.some((mention) => !original.has(mention.userId))
  );
}
export function commentDraftState(
  dirty: boolean,
  command: Readonly<{ pending: boolean; uncertain: boolean }>,
): CommentDraftState {
  if (command.pending) return 'saving';
  if (command.uncertain) return 'uncertain';
  return dirty ? 'dirty' : 'clean';
}
