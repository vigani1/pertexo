export type ConnectionHealthApplicationResult = Readonly<{
  kind: 'applied' | 'stale' | 'duplicate';
}>;
