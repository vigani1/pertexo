export type InlineRenameError = Readonly<{
  kind: 'conflict' | 'other';
  message: string;
}>;
/** A conflict can load the newer name; an accepted rename can refresh its read. */
export type InlineRenameCommand = Readonly<{
  pending: boolean;
  error: InlineRenameError | undefined;
  reloadLatest: () => Promise<boolean>;
  clearError: () => void;
  accepted?: boolean;
  refreshPending?: boolean;
  refresh?: () => Promise<boolean>;
}>;
export type RenameFormProps = Readonly<{
  command: InlineRenameCommand;
  /**
   * Sends the rename and resolves `true` once it is confirmed; the command
   * reports pending, conflicts and retries meanwhile.
   */
  onSave: (name: string, expectedRevision: number) => Promise<boolean>;
  /** Layout of the form, e.g. a row in a bar. */
  className?: string;
  value: Readonly<{
    name: string;
    revision: number;
  }>;
  field: Readonly<{
    /** What is renamed, e.g. "workflow": "Rename workflow", "This workflow changed…". */
    subject: string;
    label: string;
    /** The message for an invalid name, e.g. its length. */
    validate: (name: string) => string | undefined;
  }>;
}>;
