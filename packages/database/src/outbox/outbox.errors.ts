export class BoundedJsonInvalidError extends TypeError {
  public constructor(message = 'outbox payload must be valid bounded JSON') {
    super(message);
    this.name = 'BoundedJsonInvalidError';
  }
}
