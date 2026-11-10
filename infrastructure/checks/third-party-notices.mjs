import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const permissive = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'Zlib',
]);

// These exceptions are build inputs or font assets, not application libraries.
const exceptions = [
  {
    matches: (name) => name.startsWith('@fontsource-variable/'),
    license: 'OFL-1.1',
    reason:
      'Redistributable fonts; retain the published font license and reserved names.',
  },
  {
    matches: (name) => name === 'caniuse-lite',
    license: 'CC-BY-4.0',
    reason:
      'Build-time browser compatibility data; preserve attribution in notices.',
  },
  {
    matches: (name) =>
      name === 'lightningcss' || name.startsWith('lightningcss-'),
    license: 'MPL-2.0',
    reason:
      'Unmodified build-time CSS compiler; its source is not included in the web bundle.',
  },
];

export function requireAllowedLicense(name, license) {
  if (permissive.has(license) || license === '(MIT OR CC0-1.0)') return;
  const exception = exceptions.find(
    (item) => item.license === license && item.matches(name),
  );
  if (exception) return exception.reason;
  throw new Error(
    `Review required: ${name} declares ${license || 'a missing license'}`,
  );
}

export function createNotices(licenses) {
  const entries = [];
  for (const [license, packages] of Object.entries(licenses)) {
    for (const pkg of packages) {
      const exception = requireAllowedLicense(pkg.name, license);
      const texts = new Set();
      for (const path of pkg.paths) {
        for (const file of readdirSync(path, { withFileTypes: true })) {
          if (
            file.isFile() &&
            /^(?:licen[cs]e|copying|notice|copyright)(?:[.-]|$)/iu.test(
              file.name,
            )
          )
            texts.add(readFileSync(join(path, file.name), 'utf8'));
        }
      }
      entries.push(
        [
          `${pkg.name} ${pkg.versions.join(', ')}`,
          `License: ${license}`,
          pkg.homepage ?? '',
          exception ? `Policy exception: ${exception}` : '',
          ...texts,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
  }
  return (
    'Third-party notices\n\n' +
    entries.sort().join('\n\n' + '='.repeat(72) + '\n\n') +
    '\n'
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const licenses = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const notices = createNotices(licenses);
  if (process.argv[2]) writeFileSync(process.argv[2], notices);
  process.stdout.write(
    `License policy passed (${Object.values(licenses).flat().length} packages).\n`,
  );
}
