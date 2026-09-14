import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { createImageProvenance } from './create-image-provenance.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const input = {
  buildMetadata: { 'containerimage.digest': digest },
  commit: 'b'.repeat(40),
  imageReference: 'pertexo-ci:fixture',
  sbom: Buffer.from('sbom'),
  scan: Buffer.from('scan'),
};

test('binds SBOM and scan evidence to the built image digest', () => {
  const provenance = createImageProvenance(input);
  assert.equal(provenance.subject.digest, digest);
  assert.equal(provenance.promotion.digest, digest);
  assert.match(provenance.evidence.sbom.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(
    provenance.evidence.sbom.sha256,
    provenance.evidence.vulnerabilityScan.sha256,
  );
});

test('rejects missing or mutable image identity', () => {
  assert.throws(
    () => createImageProvenance({ ...input, buildMetadata: {} }),
    /image digest/,
  );
  assert.throws(
    () =>
      createImageProvenance({
        ...input,
        buildMetadata: { 'containerimage.digest': 'pertexo:latest' },
      }),
    /image digest/,
  );
});
