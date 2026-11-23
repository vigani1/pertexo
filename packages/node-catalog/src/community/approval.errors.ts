export class CommunityApprovalError extends Error {
  override readonly name = 'CommunityApprovalError';

  constructor(detail: string, options?: ErrorOptions) {
    super(`Community integration approval: ${detail}`, options);
  }
}
