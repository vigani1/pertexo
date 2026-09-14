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
  rollbackFailed: boolean,
  rollbackError: unknown,
  unlockFailed: boolean,
  unlockError: unknown,
  cancellationRequested: boolean,
): Error | undefined {
  if (rollbackFailed || unlockFailed)
    return new Error('Control ledger transaction cleanup failed', {
      cause: rollbackFailed ? rollbackError : unlockError,
    });
  if (cancellationRequested)
    return new Error('Control ledger transaction was canceled');
  return undefined;
}
