/** A node catalog whose identities or definition–executor edges don't agree. */
export class NodeCatalogIntegrityError extends Error {
  public override readonly name = 'NodeCatalogIntegrityError';
}
