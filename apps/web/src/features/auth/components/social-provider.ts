export type SocialProvider = 'google' | 'microsoft' | 'github' | 'apple';

export function isSocialProvider(
  value: string | null,
): value is SocialProvider {
  return (
    value === 'google' ||
    value === 'microsoft' ||
    value === 'github' ||
    value === 'apple'
  );
}

export function providerName(provider: string): string {
  return provider === 'github'
    ? 'GitHub'
    : `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`;
}
