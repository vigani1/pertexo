export class InboxChecksumMismatchError extends Error {
  public constructor() {
    super('Inbox message checksum does not match the existing receipt');
    this.name = 'InboxChecksumMismatchError';
  }
}

export class InboxReceiptUnavailableError extends Error {
  public constructor() {
    super('Inbox receipt exists outside the active workspace or is incomplete');
    this.name = 'InboxReceiptUnavailableError';
  }
}
