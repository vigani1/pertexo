export class DirectoryError extends Error {
  override readonly name = 'DirectoryError';
  constructor(
    readonly reason:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'stale'
      | 'limit'
      | 'invalid_value'
      | 'invalid_filter'
      | 'invalid_path'
      | 'no_target'
      | 'mutability'
      | 'uniqueness'
      | 'owner_protected',
  ) {
    super('Directory operation is not permitted');
  }
}
