/** Input mapping is engine-owned; outbound transports can receive mapped data. */
export function supportsExpressionMappings(
  policies: readonly Readonly<{ key: string }>[],
  capabilities: readonly string[] = [],
): boolean {
  return (
    capabilities.includes('external_http') ||
    policies.some((policy) => policy.key === 'jsonata.restricted')
  );
}
