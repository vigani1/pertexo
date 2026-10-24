export type InlineRenameError = Readonly<{
  kind: 'conflict' | 'other' | 'verification';
  message: string;
}>;

/**
 * What a feature's rename command offers the field. A conflict loads the
 * latest name (`reloadLatest`) so people choose between theirs and it; an
 * unconfirmed attempt is sent again exactly (`retry`). Commands whose page
 * may lag behind an accepted rename also offer `refresh`.
 */
export type InlineRenameCommand = Readonly<{
  pending: boolean;
  error: InlineRenameError | undefined;
  retryAvailable: boolean;
  retry: () => Promise<boolean>;
  reloadLatest: () => Promise<boolean>;
  dismiss: () => void;
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
  value: Readonly<{ name: string; revision: number }>;
  field: Readonly<{
    /** What is renamed, e.g. "workflow": "Rename workflow", "This workflow changed…". */
    subject: string;
    label: string;
    /** The message for an invalid name, e.g. its length. */
    validate: (name: string) => string | undefined;
  }>;
}>;
