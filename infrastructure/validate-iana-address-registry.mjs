import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const snapshotUrl = new URL(
  '../packages/integrations/src/http/iana-address-policy-snapshot.ts',
  import.meta.url,
);

export function parseApprovedRegistries(source) {
  const entries = [
    ...source.matchAll(/url: '([^']+)',\s+sha256: '([0-9a-f]{64})'/gu),
  ].map(([, url, sha256]) => ({ url, sha256 }));
  if (entries.length !== 2)
    throw new Error(
      'IANA snapshot must pin exactly the IPv4 and IPv6 registries',
    );
  if (new Set(entries.map(({ url }) => url)).size !== entries.length)
    throw new Error('IANA snapshot contains a duplicate registry URL');
  return entries;
}

export async function validateApprovedRegistries({
  fetchUpstream = false,
  fetchImplementation = fetch,
} = {}) {
  const source = await readFile(snapshotUrl, 'utf8');
  const entries = parseApprovedRegistries(source);
  if (!fetchUpstream) return entries;

  for (const entry of entries) {
    const response = await fetchImplementation(entry.url, {
      headers: { 'user-agent': 'pertexo-iana-registry-drift-check/1' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `IANA registry fetch failed with HTTP ${String(response.status)}`,
      );
    const actual = createHash('sha256')
      .update(new Uint8Array(await response.arrayBuffer()))
      .digest('hex');
    if (actual !== entry.sha256)
      throw new Error(
        `IANA registry changed: ${entry.url}. Review reachability semantics and update the approved snapshot in a dedicated security change.`,
      );
  }
  return entries;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fetchUpstream = process.argv.includes('--upstream');
  await validateApprovedRegistries({ fetchUpstream });
  console.log(
    fetchUpstream
      ? 'Approved IANA address registries match upstream.'
      : 'Approved IANA address-registry snapshot is structurally valid.',
  );
}
