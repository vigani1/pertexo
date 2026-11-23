import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';
import {
  communityApprovalDigest,
  loadPlatformRegistry,
  parseCommunityApprovalSet,
} from '../../../packages/node-catalog/dist/server.js';
import { createStructuredLogger } from '../../../packages/observability/dist/server.js';

export async function prepareCommunityGeneration(
  directory,
  deployment,
  approvalsJson,
) {
  const parent = join(directory, 'community');
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.staging-'));
  let reason = 'invalid_approvals';
  try {
    const approved = parseCommunityApprovalSet(
      '/community-source',
      approvalsJson,
    );
    const releases = (approved?.approvals ?? []).map(
      ({ file: _file, ...release }) => release,
    );
    const digest = communityApprovalDigest(approved?.approvals ?? []);
    reason = 'history_verification_failed';
    const reusedVersion = await findReusedVersion(directory, releases);
    if (reusedVersion !== undefined) {
      reason = 'release_version_reused';
      throw new Error(
        `Community release ${reusedVersion} already used a different SHA-256`,
      );
    }
    reason = 'release_verification_failed';
    await loadPlatformRegistry(approved, async ({ sha256 }, bytes) => {
      await writeFile(join(staging, sha256), bytes, { mode: 0o444 });
    });
    reason = 'generation_write_failed';
    const generation = join(parent, digest);
    await mkdir(generation, { recursive: true, mode: 0o755 });
    for (const { sha256 } of releases) {
      // Always publish the bytes verified by this preflight, including repair
      // of a generation whose files were changed on the host.
      await rename(join(staging, sha256), join(generation, sha256));
    }
    const stagedApprovals = releases.map((release) => ({
      ...release,
      file: release.sha256,
    }));
    const environment = [
      `COMMUNITY_GENERATION=${digest}`,
      `COMMUNITY_GENERATION_APPROVALS='${JSON.stringify(stagedApprovals)}'`,
      '',
    ].join('\n');
    await writeFile(join(directory, 'community.next.env'), environment, {
      mode: 0o600,
    });
    await audit(directory, deployment, {
      phase: 'preflight',
      result: 'accepted',
      digest,
      releases,
    });
  } catch (error) {
    await audit(directory, deployment, {
      phase: 'preflight',
      result: 'rejected',
      reason,
    });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function auditCommunityActivation(directory, deployment) {
  const active = await readGeneration(directory, 'community.env');
  const proposed = await readGeneration(directory, 'community.next.env');
  const selected = new Set(proposed.releases.map(({ sha256 }) => sha256));
  await audit(directory, deployment, {
    phase: 'activation',
    result: 'enabling',
    ...proposed,
    removed: active.releases.filter(({ sha256 }) => !selected.has(sha256)),
  });
}

async function readGeneration(directory, name) {
  let text;
  try {
    text = await readFile(join(directory, name), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { releases: [] };
    throw error;
  }
  const values = parseEnv(text);
  const approved = parseCommunityApprovalSet(
    '/community-source',
    values.COMMUNITY_GENERATION_APPROVALS,
    values.COMMUNITY_GENERATION,
  );
  return {
    digest: values.COMMUNITY_GENERATION,
    releases: (approved?.approvals ?? []).map(
      ({ file: _file, ...release }) => release,
    ),
  };
}

async function findReusedVersion(directory, releases) {
  if (releases.length === 0) return;
  const proposed = new Map(
    releases.map((release) => [releaseIdentity(release), release.sha256]),
  );
  const input = createReadStream(join(directory, 'community-deployment.log'));
  const lines = createInterface({ input });
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (
        event.event !== 'community.release_set' ||
        event.phase !== 'activation'
      )
        continue;
      for (const release of event.releases) {
        const identity = releaseIdentity(release);
        const sha256 = proposed.get(identity);
        if (sha256 !== undefined && sha256 !== release.sha256) return identity;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

function releaseIdentity({ providerKey, version }) {
  return `${providerKey}@${version}`;
}

async function audit(directory, deployment, fields) {
  const destination = createWriteStream(
    join(directory, 'community-deployment.log'),
    {
      flags: 'a',
      mode: 0o600,
    },
  );
  const logger = createStructuredLogger(
    {
      environment: 'production',
      serviceName: 'deployment',
      serviceVersion: deployment,
      logLevel: 'info',
    },
    destination,
  );
  const completed = finished(destination);
  logger.info('community.release_set', {
    actor: 'host_deployment',
    deployment,
    ...fields,
  });
  destination.end();
  await completed;
}
