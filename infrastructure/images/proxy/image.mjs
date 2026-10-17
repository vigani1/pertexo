import { readFileSync } from 'node:fs';

const compose = readFileSync(
  new URL('../../single-server/compose.yaml', import.meta.url),
  'utf8',
);
const image = compose.match(
  /^\s+image:\s+(caddy:[\w.-]+@sha256:[a-f0-9]{64})$/mu,
)?.[1];
if (image === undefined)
  throw new Error('The single-server Caddy image must be pinned');
console.log(image);
