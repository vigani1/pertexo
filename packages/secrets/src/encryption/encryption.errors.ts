export class ApplicationKeyConfigurationError extends TypeError {
  public override readonly name = 'ApplicationKeyConfigurationError';
  public constructor(
    public readonly section: 'current' | 'previous',
    message: string,
  ) {
    super(message);
  }
}

export type VerificationFailure =
  | 'incompatible_provider'
  | 'unavailable_key_material'
  | 'inventory_unavailable'
  | 'cancelled';

export class StoredKeyVerificationError extends Error {
  public override readonly name = 'StoredKeyVerificationError';
  public constructor(public readonly code: VerificationFailure) {
    super(
      {
        incompatible_provider:
          'Stored secrets use a different encryption provider; provider migration is not supported',
        unavailable_key_material:
          'A stored encryption key is unavailable or damaged; check current and previous master keys',
        inventory_unavailable: 'Stored encryption key inventory is unavailable',
        cancelled: 'Stored encryption key verification was cancelled',
      }[code],
    );
  }
}

export class ConnectionSecretEncryptionError extends Error {
  public override readonly name = 'ConnectionSecretEncryptionError';

  public constructor() {
    super('Connection secret encryption failed');
  }
}

export class ApplicationSecretKeyUnavailableError extends Error {
  public constructor(public readonly keyVersion: string) {
    super('Application secret key is unavailable');
    this.name = 'ApplicationSecretKeyUnavailableError';
  }
}

export class WebhookTriggerSecretEncryptionError extends Error {
  public override readonly name = 'WebhookTriggerSecretEncryptionError';

  public constructor() {
    super('Webhook trigger secret encryption failed');
  }
}

/** The CONNECTION_* settings can't make one valid encryption config. */
export class ConnectionEncryptionConfigurationError extends Error {
  public override readonly name = 'ConnectionEncryptionConfigurationError';
}

/** Reading or releasing the stored key inventory failed. */
export class EncryptionKeyInventoryError extends Error {
  public override readonly name = 'EncryptionKeyInventoryError';
}
