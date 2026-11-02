export type EditingPresence = Readonly<{
  editing: boolean;
  dirty: boolean;
  baseRevision: number | null;
}>;
export const VIEWING_PRESENCE: EditingPresence = {
  editing: false,
  dirty: false,
  baseRevision: null,
};

const TAB_ID_KEY = 'pertexo.presence.tab';

/**
 * One identity per browser tab, kept across a reload: a new one would leave the
 * old lease to expire, and read as this person being "also in another tab".
 * A duplicated tab copies it and counts as one until it reloads, which is harmless.
 */
export function browserTabId(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  try {
    const known = storage.getItem(TAB_ID_KEY);
    if (known !== null) return known;
    const created = crypto.randomUUID();
    storage.setItem(TAB_ID_KEY, created);
    return created;
  } catch {
    // Storage can be refused; presence is advisory, so only the reload suffers.
    return crypto.randomUUID();
  }
}
