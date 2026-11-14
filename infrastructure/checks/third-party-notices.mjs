import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const supplements = JSON.parse(
  readFileSync(new URL('./license-supplements.json', import.meta.url), 'utf8'),
);
const copiedSoftware = JSON.parse(
  readFileSync(
    new URL('./copied-software-licenses.json', import.meta.url),
    'utf8',
  ),
);

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
  {
    matches: (name) => name === 'axe-core' || name === '@axe-core/playwright',
    license: 'MPL-2.0',
    reason:
      'Unmodified test-only accessibility checker; absent from the web bundle and the runtime image.',
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
      let missingTextReason;
      let needsSupplement = pkg.paths.length === 0;
      for (const path of pkg.paths) {
        const publishedTexts = new Set();
        for (const file of readdirSync(path, { withFileTypes: true })) {
          if (
            file.isFile() &&
            /^(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/iu.test(
              file.name,
            )
          )
            publishedTexts.add(readFileSync(join(path, file.name), 'utf8'));
        }
        if (![...publishedTexts].some(hasLicenseText)) {
          for (const file of readdirSync(path)) {
            if (/^readme(?:\.[^.]+)?$/iu.test(file)) {
              const readme = readFileSync(join(path, file), 'utf8');
              for (const text of readmeLicenseSections(readme))
                publishedTexts.add(text);
            }
          }
        }
        if (![...publishedTexts].some(hasLicenseText)) needsSupplement = true;
        for (const text of publishedTexts) texts.add(text);
      }
      if (needsSupplement) {
        const supplement = supplements.find(
          (item) =>
            item.license === license &&
            (item.names.includes(pkg.name) ||
              (item.prefix && pkg.name.startsWith(item.prefix))) &&
            pkg.versions.every((version) => item.versions.includes(version)),
        );
        if (supplement) {
          texts.add(
            `Upstream text: ${supplement.source}\n${supplement.reason}`,
          );
          if (supplement.text) texts.add(supplement.text);
          missingTextReason = supplement.missingTextReason;
          if (supplement.text && hasLicenseText(supplement.text))
            needsSupplement = false;
        }
      }
      if (needsSupplement && !missingTextReason)
        throw new Error(
          `Missing license text: ${pkg.name} ${pkg.versions.join(', ')}`,
        );
      entries.push(
        [
          `${pkg.name} ${pkg.versions.join(', ')}`,
          `License: ${license}`,
          pkg.homepage ?? '',
          exception ? `Policy exception: ${exception}` : '',
          missingTextReason
            ? `Missing-text exception: ${missingTextReason}`
            : '',
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

function hasLicenseText(text) {
  return /Permission is hereby granted|Permission to use|Redistribution and use|Apache License[\s\S]{100}|SIL OPEN FONT LICENSE[\s\S]{100}|Mozilla Public License[\s\S]{100}|Blue Oak Model License[\s\S]{100}|CC0 1.0 Universal[\s\S]{100}|public domain|license agreement/iu.test(
    text,
  );
}

function readmeLicenseSections(readme) {
  const text = readme.replaceAll('\r\n', '\n');
  const headings = [
    ...text.matchAll(/^(#{1,6})\s+(.+)$|^([^\n]+)\n([=-]+)\s*$/gmu),
  ].map((match) => ({
    start: match.index,
    title: match[2] ?? match[3],
    level: match[1]?.length ?? (match[4][0] === '=' ? 1 : 2),
  }));
  return headings
    .filter((heading) => /licen[cs]e|copyright/iu.test(heading.title))
    .map((heading) => {
      const next = headings.find(
        (item) => item.start > heading.start && item.level <= heading.level,
      );
      return text.slice(heading.start, next?.start).trim();
    });
}

export function createCopiedSoftwareNotices(
  inventory,
  dockerfile,
  { pythonLicense } = {},
) {
  if (
    !dockerfile.includes(inventory.python.archive) ||
    !dockerfile.includes(`sha256:${inventory.python.sha256}`)
  )
    throw new Error(
      'Review copied-software inventory after changing image/download pins',
    );

  if (
    pythonLicense !== undefined &&
    pythonLicense !==
      inventory.python.texts.find((item) => item.file === 'LICENSE')?.text
  )
    throw new Error('Review copied-software inventory: Python license changed');

  return (
    '\nCopied non-npm software (runtime inventory; included in both image notice files)\n\n' +
    [inventory.python]
      .map((component) => {
        requireAllowedLicense(component.name, component.license);
        if (!component.texts.some((item) => item.text.trim()))
          throw new Error(`Missing license text: ${component.name}`);
        return [
          `${component.name} ${component.version}`,
          `License: ${component.license}`,
          component.source,
          component.goSum ? `Go module checksum: ${component.goSum}` : '',
          ...component.texts.map((item) => `${item.file}\n\n${item.text}`),
        ]
          .filter(Boolean)
          .join('\n\n');
      })
      .join('\n\n' + '='.repeat(72) + '\n\n') +
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
  const notices =
    createNotices(licenses) +
    createCopiedSoftwareNotices(
      copiedSoftware,
      readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8'),
      {
        ...(process.argv[3]
          ? { pythonLicense: readFileSync(process.argv[3], 'utf8') }
          : {}),
      },
    );
  if (process.argv[2]) writeFileSync(process.argv[2], notices);
  process.stdout.write(
    `License policy passed (${Object.values(licenses).flat().length} packages).\n`,
  );
}
