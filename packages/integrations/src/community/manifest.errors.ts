export class CommunityManifestError extends Error {
  override readonly name = 'CommunityManifestError';

  constructor(detail: string, options?: ErrorOptions) {
    super(`Community integration manifest: ${detail}`, options);
  }
}
