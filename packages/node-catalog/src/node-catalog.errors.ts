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
