#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

function sha256(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

export function createImageProvenance({
  buildMetadata,
  commit,
  imageReference,
  sbom,
  scan,
}) {
  const imageDigest = buildMetadata['containerimage.digest'];
  if (typeof imageDigest !== 'string' || !digestPattern.test(imageDigest)) {
    throw new Error(
      'Build metadata must contain a sha256 container image digest',
    );
  }
  if (!commitPattern.test(commit)) {
    throw new Error('Provenance commit must be a full Git SHA');
  }
  if (imageReference.length === 0) {
    throw new Error('Provenance image reference is required');
  }
  return Object.freeze({
    schemaVersion: 1,
    subject: Object.freeze({
      imageReference,
      digest: imageDigest,
      commit,
    }),
    evidence: Object.freeze({
      sbom: Object.freeze({
        format: 'cyclonedx-json',
        sha256: sha256(sbom),
      }),
      vulnerabilityScan: Object.freeze({
        format: 'grype-json',
        sha256: sha256(scan),
      }),
    }),
    promotion: Object.freeze({
      mode: 'external-registry-required',
      digest: imageDigest,
    }),
  });
}

async function main(args) {
  if (args.length !== 6) {
    throw new Error(
      'usage: create-image-provenance <build-metadata> <sbom> <scan> <commit> <image-reference> <output>',
    );
  }
  const [metadataPath, sbomPath, scanPath, commit, imageReference, outputPath] =
    args;
  const provenance = createImageProvenance({
    buildMetadata: JSON.parse(await readFile(metadataPath, 'utf8')),
    commit,
    imageReference,
    sbom: await readFile(sbomPath),
    scan: await readFile(scanPath),
  });
  await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
