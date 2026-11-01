export class FormUnavailableError extends Error {
  override readonly name = 'FormUnavailableError';
}

export class FormChangedError extends Error {
  override readonly name = 'FormChangedError';
}

export class FormAccessConflictError extends Error {
  override readonly name = 'FormAccessConflictError';
}
