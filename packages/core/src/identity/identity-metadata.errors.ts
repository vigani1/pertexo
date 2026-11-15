/** Identity metadata broke a shape or size rule. */
export class IdentityMetadataValidationError extends Error {
  public override readonly name = 'IdentityMetadataValidationError';
}

/** Inspecting identity metadata itself threw (a hostile getter or proxy), so it is refused. */
export class IdentityMetadataInspectionError extends Error {
  public override readonly name = 'IdentityMetadataInspectionError';
  public constructor() {
    super('Identity metadata could not be inspected safely');
  }
}
