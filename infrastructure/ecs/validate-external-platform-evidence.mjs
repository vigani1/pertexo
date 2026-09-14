import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateEvidenceAgainstContracts } from './external-platform-evidence-contracts.mjs';

const root = resolve(import.meta.dirname, '../..');
const contractFiles = Object.freeze({
  autoscalingSha256: 'autoscaling.json',
  externalPlatformSha256: 'external-platform-contract.json',
  workloadsSha256: 'workloads.json',
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function loadDeploymentContracts(repositoryRoot = root) {
  const entries = await Promise.all(
    Object.entries(contractFiles).map(async ([fingerprintName, file]) => {
      const bytes = await readFile(
        resolve(repositoryRoot, 'infrastructure/ecs', file),
      );
      return [
        fingerprintName,
        { bytes, parsed: JSON.parse(bytes.toString('utf8')) },
      ];
    }),
  );
  const loaded = Object.fromEntries(entries);
  return {
    autoscaling: loaded.autoscalingSha256.parsed,
    contract: loaded.externalPlatformSha256.parsed,
    fingerprints: Object.fromEntries(
      entries.map(([name, value]) => [name, sha256(value.bytes)]),
    ),
    workloads: loaded.workloadsSha256.parsed,
  };
}

export async function loadDeploymentContract(repositoryRoot = root) {
  const { contract } = await loadDeploymentContracts(repositoryRoot);
  const bytes = await readFile(
    resolve(
      repositoryRoot,
      'infrastructure/ecs/external-platform-contract.json',
    ),
  );
  return { bytes, contract };
}

export async function validateExternalPlatformEvidence(
  evidence,
  { now = new Date(), repositoryRoot = root } = {},
) {
  const contracts = await loadDeploymentContracts(repositoryRoot);
  validateEvidenceAgainstContracts(evidence, { ...contracts, now });
}

async function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath)
    throw new Error(
      'usage: node infrastructure/ecs/validate-external-platform-evidence.mjs <aws-evidence.json>',
    );
  const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
  await validateExternalPlatformEvidence(evidence);
  process.stdout.write(
    'Normalized deployment evidence matches the reviewed contracts; raw observation references still require independent authentication.\n',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
