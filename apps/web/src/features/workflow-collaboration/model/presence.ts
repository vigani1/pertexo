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
