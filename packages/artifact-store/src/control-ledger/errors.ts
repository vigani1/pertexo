export class ControlLedgerReadinessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlLedgerReadinessError';
  }
}

export class ControlLedgerConflictError extends Error {
  public constructor() {
    super('Control ledger sequence already contains a different record');
    this.name = 'ControlLedgerConflictError';
  }
}

export class ControlLedgerIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlLedgerIntegrityError';
  }
}

export class ControlLedgerClosedError extends Error {
  public constructor() {
    super('Control ledger is closed');
    this.name = 'ControlLedgerClosedError';
  }
}
