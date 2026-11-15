export class RunValuesLimitError extends Error {
  override readonly name = 'RunValuesLimitError';
  constructor() {
    super(
      'A run can keep at most ten distinct values. Reuse an existing key or save fewer values.',
    );
  }
}
