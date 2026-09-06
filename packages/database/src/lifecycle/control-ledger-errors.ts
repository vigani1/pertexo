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
