export class McpExposureConflictError extends Error {
  override readonly name = 'McpExposureConflictError';
  public constructor(
    public readonly reason:
      'version_changed' | 'entry_unavailable' | 'name_in_use',
  ) {
    super('The workflow tool exposure could not be updated.');
  }
}
