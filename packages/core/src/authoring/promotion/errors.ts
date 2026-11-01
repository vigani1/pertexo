export class WorkflowPromotionError extends Error {
  override readonly name = 'WorkflowPromotionError';
  constructor(
    readonly reason:
      'unavailable' | 'stale' | 'incompatible' | 'limit' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
