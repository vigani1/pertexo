import {
  canonicalCompatibilityReleaseJson,
  createRegistryRelease,
  createRegistryReleaseSuccessor,
  parseRegistryRelease,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import {
  PHASE3_RUNTIME_POLICIES_V1,
  fail,
  globalPolicies,
  normalizeError,
} from './executable-foundation.js';

export function composeExecutableCompatibilityRelease(
  nodeReleaseInput: unknown,
): RegistryRelease {
  try {
    const nodeRelease = parseRegistryRelease(nodeReleaseInput);
    if (nodeRelease.policies.some(({ key }) => key.startsWith('engine.')))
      fail('node release must not declare engine runtime policies');
    return createRegistryRelease({
      epoch: nodeRelease.epoch,
      definitions: nodeRelease.definitions,
      executors: nodeRelease.executors,
      policies: [
        ...nodeRelease.policies,
        ...globalPolicies(PHASE3_RUNTIME_POLICIES_V1),
      ],
    });
  } catch (error) {
    normalizeError(error);
  }
}

export type ExecutableCompatibilityReleaseDescription = Readonly<{
  epoch: number;
  fingerprint: string;
  catalogJson: string;
}>;

export type ExecutableCompatibilityReleaseSupport = Readonly<{
  descriptions: readonly ExecutableCompatibilityReleaseDescription[];
  resolve(epoch: number, fingerprint: string): RegistryRelease;
}>;

export function describeExecutableCompatibilityRelease(
  releaseInput: unknown,
): ExecutableCompatibilityReleaseDescription {
  try {
    const release = parseRegistryRelease(releaseInput);
    return Object.freeze({
      epoch: release.epoch,
      fingerprint: release.fingerprint,
      catalogJson: canonicalCompatibilityReleaseJson(release),
    });
  } catch (error: unknown) {
    normalizeError(error);
  }
}

export function createExecutableCompatibilityReleaseSupport(
  releaseInputs: readonly unknown[],
): ExecutableCompatibilityReleaseSupport {
  try {
    if (releaseInputs.length < 1 || releaseInputs.length > 2)
      fail('artifact supports only one rolling overlap');
    return createExecutableCompatibilityReleaseHistory(releaseInputs);
  } catch (error: unknown) {
    normalizeError(error);
  }
}

/**
 * Every immutable release whose published workflows remain executable by an
 * artifact. Deployment readiness must use the bounded rolling-support factory
 * above; retained execution history is a separate compatibility concern.
 */
export function createExecutableCompatibilityReleaseHistory(
  releaseInputs: readonly unknown[],
): ExecutableCompatibilityReleaseSupport {
  try {
    if (releaseInputs.length < 1)
      fail('executable compatibility history must not be empty');
    const releases = releaseInputs
      .map(parseRegistryRelease)
      .sort((left, right) => left.epoch - right.epoch);
    if (new Set(releases.map(({ epoch }) => epoch)).size !== releases.length)
      fail('compatibility release epochs must be unique');
    for (let index = 1; index < releases.length; index += 1) {
      const previous = releases[index - 1];
      const target = releases[index];
      if (previous === undefined || target === undefined)
        fail('executable compatibility history is incomplete');
      if (target.epoch !== previous.epoch + 1)
        fail('compatibility release is not the next successor');
      const successor = createRegistryReleaseSuccessor({
        epoch: target.epoch,
        definitions: target.definitions,
        executors: target.executors,
        policies: target.policies,
        previous,
      });
      if (successor.fingerprint !== target.fingerprint)
        fail('compatibility release successor fingerprint changed');
    }
    const byPair = new Map(
      releases.map((release) => [
        `${String(release.epoch)}\u0000${release.fingerprint}`,
        release,
      ]),
    );
    const descriptions = Object.freeze(
      releases.map(describeExecutableCompatibilityRelease),
    );
    return Object.freeze({
      descriptions,
      resolve: (epoch: number, fingerprint: string): RegistryRelease => {
        if (!Number.isInteger(epoch) || epoch < 1)
          fail('compatibility release is not supported by this artifact');
        const release = byPair.get(`${String(epoch)}\u0000${fingerprint}`);
        if (release === undefined)
          fail('compatibility release is not supported by this artifact');
        return release;
      },
    });
  } catch (error: unknown) {
    normalizeError(error);
  }
}
