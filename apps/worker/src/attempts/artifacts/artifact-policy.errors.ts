export class ArtifactByteLimitError extends TypeError {
  public override readonly name = 'ArtifactByteLimitError';
}

export class ArtifactRetentionExpiredError extends RangeError {
  public override readonly name = 'ArtifactRetentionExpiredError';
}
