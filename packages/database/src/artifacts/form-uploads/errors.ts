/**
 * A begin that would pass an upload cap: one response began more uploads than
 * any honest response needs, or public-link files nobody has sent yet already
 * fill the workspace's allowance.
 */
export class FormUploadLimitError extends Error {
  override readonly name = 'FormUploadLimitError';
  constructor(readonly reason: 'response' | 'unsent_public') {
    super(
      reason === 'response'
        ? 'This response has started too many uploads.'
        : 'Unsent public form files fill this workspace’s allowance.',
    );
  }
}
