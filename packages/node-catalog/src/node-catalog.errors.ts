/** No node with this key and version is in the platform catalog. */
export class PlatformNodeDefinitionUnavailableError extends Error {
  public override readonly name = 'PlatformNodeDefinitionUnavailableError';

  public constructor() {
    super('Platform node definition is not implemented');
  }
}

/** A catalog node needs a connection slot the portable policy doesn't describe. */
export class PortableConnectionSlotPolicyError extends Error {
  public override readonly name = 'PortableConnectionSlotPolicyError';

  public constructor() {
    super('Portable connection slot policy is unavailable');
  }
}

export class IntegrationRegistryError extends Error {
  public override readonly name = 'IntegrationRegistryError';

  public constructor(
    kind:
      | 'module'
      | 'step'
      | 'connection'
      | 'slot'
      | 'slot reference'
      | 'secret default',
    key: string,
  ) {
    super(
      kind === 'slot reference' || kind === 'secret default'
        ? `Invalid integration ${kind}: ${key}`
        : `Duplicate integration ${kind} key: ${key}`,
    );
  }
}
