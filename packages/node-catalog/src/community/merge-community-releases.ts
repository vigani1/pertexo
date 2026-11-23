import { compareOrdinal } from '@pertexo/workflow-model';
import type { IntegrationModule } from '@pertexo/integrations/server';
import { CommunityApprovalError } from './approval.errors.js';
import type { CommunityApproval } from './approvals.js';

type LoadedRelease = Readonly<{
  approval: CommunityApproval;
  module: IntegrationModule;
}>;

export function mergeCommunityReleases(
  releases: readonly LoadedRelease[],
): readonly IntegrationModule[] {
  const byProvider = new Map<string, LoadedRelease[]>();
  for (const release of releases) {
    const { providerKey } = release.approval;
    const versions = byProvider.get(providerKey) ?? [];
    versions.push(release);
    byProvider.set(providerKey, versions);
  }
  return [...byProvider.values()].map(mergeProvider);
}

function mergeProvider(releases: LoadedRelease[]): IntegrationModule {
  releases.sort(
    (left, right) =>
      Number(right.approval.current) - Number(left.approval.current) ||
      compareOrdinal(left.approval.version, right.approval.version),
  );
  const [first] = releases;
  if (!first) throw new CommunityApprovalError('provider has no releases');
  const versions = new Set<string>();
  const steps = new Map<string, IntegrationModule['steps'][number]>();
  const connections = new Map<
    string,
    NonNullable<IntegrationModule['connections']>[number]
  >();
  for (const { approval, module } of releases) {
    if (versions.has(approval.version))
      throw new CommunityApprovalError(
        `Duplicate integration module key and version: ${module.key}@${approval.version}`,
      );
    if (versions.size > 0 && approval.current)
      throw new CommunityApprovalError(
        `${module.key} has multiple current releases`,
      );
    versions.add(approval.version);
    for (const connection of module.connections ?? []) {
      if (!connections.has(connection.authType))
        connections.set(connection.authType, connection);
    }
    for (const step of module.steps) {
      const { key } = step.registration.manifest.definition;
      if (steps.has(key)) continue;
      steps.set(key, {
        ...step,
        presentation: {
          ...module.presentation,
          ...(module.presentation.community === undefined
            ? {}
            : {
                community: {
                  ...module.presentation.community,
                  version: approval.version,
                  ...(approval.current ? {} : { retained: true }),
                },
              }),
          ...step.presentation,
          name:
            step.registration.manifest.display?.name ??
            module.presentation.name,
        },
      });
    }
  }
  return {
    ...first.module,
    steps: [...steps.values()],
    connections: [...connections.values()],
  };
}
