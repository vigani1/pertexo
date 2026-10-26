/** One response began more uploads than any honest response needs. */
export class FormUploadLimitError extends Error {
  override readonly name = 'FormUploadLimitError';
  constructor() {
    super('This response has started too many uploads.');
  }
}
