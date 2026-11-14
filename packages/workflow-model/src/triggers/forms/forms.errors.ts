import type { FormFileRejection } from './files.js';

export class FormFileRejectedError extends Error {
  override readonly name = 'FormFileRejectedError';
  constructor(
    readonly reason: FormFileRejection,
    message: string,
  ) {
    super(message);
  }
}

export class FormValuesInvalidError extends Error {
  override readonly name = 'FormValuesInvalidError';
  constructor(
    readonly fields: readonly Readonly<{ name: string; message: string }>[],
  ) {
    super(
      fields.length === 1 && fields[0]?.name === ''
        ? fields[0].message
        : 'Check the form fields and try again.',
    );
  }
}
