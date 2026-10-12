import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function parseRecoveryPoint(value) {
  if (!/^[0-9]{8}T[0-9]{6}Z$/u.test(value))
    throw new Error('A UTC recovery point YYYYMMDDTHHMMSSZ is required');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  const date = new Date(iso);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== iso.replace('Z', '.000Z')
  )
    throw new Error('The recovery point date is invalid');
  return { id: value, time: date.getTime() };
}
export function expiredRecoveryPoints(listing, now) {
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  return listing.split('\n').flatMap((line) => {
    const match = /^pertexo-beta\/([0-9]{8}T[0-9]{6}Z)\/$/u.exec(line);
    if (!match) return [];
    try {
      const point = parseRecoveryPoint(match[1]);
      return point.time < cutoff ? [`pertexo-beta/${point.id}`] : [];
    } catch {
      return [];
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, value] = process.argv.slice(2);
  if (mode === 'validate')
    process.stdout.write(parseRecoveryPoint(value).id + '\n');
  else if (mode === 'expired') {
    const listing = await readFile(value, 'utf8');
    process.stdout.write(
      expiredRecoveryPoints(listing, Date.now())
        .map((prefix) => prefix + '\n')
        .join(''),
    );
  } else
    throw new Error(
      'usage: recovery-points.mjs validate <id> | expired <listing-file>',
    );
}
