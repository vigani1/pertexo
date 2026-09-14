import type { PoolClient } from 'pg';
import {
  EMPTY_DEFINITION_CATALOG_V1,
  type WorkflowDefinitionCatalogV1,
} from '@pertexo/workflow-model/graph';

import {
  lockExpectedCompatibilityReleaseSetWithClient,
  lockExpectedCompatibilityReleaseWithClient,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationHistory,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
} from '../compatibility/compatibility-release.js';
import type {
  WorkflowAuthoringDatabaseOptions,
  WorkflowExecutableCompiler,
} from './workflow-authoring-types.js';

type WorkflowAuthoringCompatibilitySelection = Readonly<{
  compatibilityRelease: CompatibilityReleaseExpectation | undefined;
  definitionCatalog: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog: WorkflowDefinitionCatalogV1 | undefined;
  executableCompiler: WorkflowExecutableCompiler | undefined;
}>;

type WorkflowAuthoringCompatibility = Readonly<{
  selectLocked(
    client: Pick<PoolClient, 'query'>,
  ): Promise<WorkflowAuthoringCompatibilitySelection>;
}>;

function sameRelease(
  left: CompatibilityReleaseExpectation,
  right: CompatibilityReleaseExpectation,
): boolean {
  return (
    left.epoch === right.epoch &&
    left.fingerprint === right.fingerprint &&
    left.catalogJson === right.catalogJson
  );
}

function requireMatchingCatalog(
  release: CompatibilityReleaseExpectation,
  definitionCatalog: WorkflowDefinitionCatalogV1,
  placementDefinitionCatalog: WorkflowDefinitionCatalogV1,
  message: string,
): void {
  if (
    definitionCatalog.releaseFingerprint !== release.fingerprint ||
    placementDefinitionCatalog.releaseFingerprint !== release.fingerprint
  )
    throw new TypeError(message);
}

export function normalizeWorkflowAuthoringCompatibility(
  options: WorkflowAuthoringDatabaseOptions,
): WorkflowAuthoringCompatibility {
  const variants = options.compatibilityReleaseVariants;
  if (
    variants !== undefined &&
    (options.compatibilityRelease !== undefined ||
      options.definitionCatalog !== undefined ||
      options.placementDefinitionCatalog !== undefined ||
      options.executableCompiler !== undefined)
  )
    throw new TypeError(
      'Compatibility release variants cannot be combined with singular publication options',
    );
  if (
    options.compatibilityReadinessReleases !== undefined &&
    variants === undefined
  )
    throw new TypeError(
      'Compatibility readiness releases require publication variants',
    );

  if (variants === undefined) {
    const compatibilityRelease =
      options.compatibilityRelease === undefined
        ? undefined
        : parseCompatibilityReleaseExpectation(options.compatibilityRelease);
    const definitionCatalog =
      options.definitionCatalog ?? EMPTY_DEFINITION_CATALOG_V1;
    if (
      options.executableCompiler !== undefined &&
      (compatibilityRelease === undefined ||
        definitionCatalog.releaseFingerprint !==
          compatibilityRelease.fingerprint)
    )
      throw new TypeError(
        'Executable workflow publication requires matching compatibility authority',
      );
    if (
      options.placementDefinitionCatalog !== undefined &&
      (compatibilityRelease === undefined ||
        options.placementDefinitionCatalog.releaseFingerprint !==
          compatibilityRelease.fingerprint)
    )
      throw new TypeError(
        'Workflow placement requires matching compatibility authority',
      );
    const selection = Object.freeze({
      compatibilityRelease,
      definitionCatalog,
      placementDefinitionCatalog: options.placementDefinitionCatalog,
      executableCompiler: options.executableCompiler,
    });
    return Object.freeze({
      selectLocked: async (client) => {
        if (compatibilityRelease !== undefined)
          await lockExpectedCompatibilityReleaseWithClient(
            client,
            compatibilityRelease,
          );
        return selection;
      },
    });
  }

  const releases = parseCompatibilityReleaseExpectationHistory(
    variants.map(({ compatibilityRelease }) => compatibilityRelease),
  );
  const normalizedVariants = Object.freeze(
    releases.map((release, index) => {
      const variant = variants[index];
      if (variant === undefined)
        throw new Error('Compatibility release variant is unavailable');
      requireMatchingCatalog(
        release,
        variant.definitionCatalog,
        variant.placementDefinitionCatalog,
        'Executable workflow publication requires matching compatibility variants',
      );
      return Object.freeze({
        compatibilityRelease: release,
        definitionCatalog: variant.definitionCatalog,
        placementDefinitionCatalog: variant.placementDefinitionCatalog,
        executableCompiler: variant.executableCompiler,
      });
    }),
  );
  const readiness =
    options.compatibilityReadinessReleases === undefined
      ? undefined
      : parseCompatibilityReleaseExpectationSet(
          options.compatibilityReadinessReleases,
        );
  if (normalizedVariants.length > 2 && readiness === undefined)
    throw new TypeError(
      'Retained publication history requires bounded compatibility readiness releases',
    );
  if (
    readiness?.some(
      (candidate) =>
        !normalizedVariants.some(({ compatibilityRelease }) =>
          sameRelease(compatibilityRelease, candidate),
        ),
    ) === true
  )
    throw new TypeError(
      'Compatibility readiness release is missing a publication variant',
    );
  const supported =
    readiness ??
    normalizedVariants.map(({ compatibilityRelease }) => compatibilityRelease);

  return Object.freeze({
    selectLocked: async (client) => {
      const selected = await lockExpectedCompatibilityReleaseSetWithClient(
        client,
        supported,
      );
      const variant = normalizedVariants.find(({ compatibilityRelease }) =>
        sameRelease(compatibilityRelease, selected),
      );
      if (variant === undefined)
        throw new Error('Locked compatibility release variant is unavailable');
      return variant;
    },
  });
}
