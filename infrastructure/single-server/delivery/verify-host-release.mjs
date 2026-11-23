import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL(
    '../../../packages/node-sdk/src/execution/executor-binding.ts',
    import.meta.url,
  ),
  'utf8',
);
const hostRelease = source.match(
  /^export const PERTEXO_HOST_RELEASE = '((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))';$/mu,
)?.[1];
if (hostRelease === undefined)
  throw new Error('PERTEXO_HOST_RELEASE must be a stable SemVer string');

const [tag] = process.argv.slice(2);
if (tag !== `v${hostRelease}`)
  throw new Error(
    `Release tag ${tag} must match PERTEXO_HOST_RELEASE (v${hostRelease})`,
  );
