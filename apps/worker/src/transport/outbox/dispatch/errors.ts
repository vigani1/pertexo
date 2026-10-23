export class OutboxPayloadChecksumError extends Error {
  public constructor(eventId: string) {
    super(`Outbox event ${eventId} has an invalid payload checksum`);
    this.name = 'OutboxPayloadChecksumError';
  }
}

export class OutboxContractError extends Error {
  public constructor(eventId: string, cause: unknown) {
    super(`Outbox event ${eventId} does not match a queue contract`, { cause });
    this.name = 'OutboxContractError';
  }
}

export class OutboxDispatcherClosedError extends Error {
  public constructor() {
    super('Outbox dispatcher is closed');
    this.name = 'OutboxDispatcherClosedError';
  }
}
