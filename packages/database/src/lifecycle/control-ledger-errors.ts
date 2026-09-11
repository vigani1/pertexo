export class ControlLedgerCommandConflictError extends Error {
  public constructor() {
    super('Control ledger command replay conflicts with the requested payload');
    this.name = 'ControlLedgerCommandConflictError';
  }
}

export class ControlLedgerReconciliationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlLedgerReconciliationError';
  }
}

export class ControlLedgerReconciliationBoundError extends ControlLedgerReconciliationError {
  public constructor() {
    super('Control ledger reconciliation invocation bound exceeded');
  }
}

export function controlLedgerClientReleaseError(
  rollbackError: unknown,
  cancellationRequested: boolean,
): Error | undefined {
  if (rollbackError instanceof Error) return rollbackError;
  if (cancellationRequested)
    return new Error('Control ledger transaction was canceled');
  if (rollbackError === undefined) return undefined;
  return new Error('Control ledger transaction could not roll back');
}
