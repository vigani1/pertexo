export class PublicationReviewError extends Error {
  override readonly name = 'PublicationReviewError';
  constructor(
    readonly reason:
      'required' | 'disabled' | 'stale' | 'self' | 'decided' | 'limit',
    message: string,
  ) {
    super(message);
  }
}
