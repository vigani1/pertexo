export class StoredExecutionValueInvalidError extends TypeError {
  public override readonly name = 'StoredExecutionValueInvalidError';

  public constructor() {
    super('Stored execution value violates the persistence contract');
  }
}
