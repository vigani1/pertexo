import type { PoolClient } from 'pg';
import {
  EMPTY_DEFINITION_CATALOG_V1,
  type WorkflowDefinitionCatalogV1,
} from '@pertexo/workflow-model/server';

import {
  selectServingCompatibilityRelease,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationHistory,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
} from '../compatibility/compatibility-release.js';
import type {
  PortableCatalog,
  WorkflowAuthoringDatabaseOptions,
  WorkflowExecutableCompiler,
  WorkflowAuthoringGraphValidator,
} from './workflow-authoring-types.js';

type WorkflowAuthoringCompatibilitySelection = Readonly<{
  portableCatalog: PortableCatalog | undefined;
  compatibilityRelease: CompatibilityReleaseExpectation | undefined;
  definitionCatalog: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog: WorkflowDefinitionCatalogV1 | undefined;
  executableCompiler: WorkflowExecutableCompiler | undefined;
  validateAuthoringGraph: WorkflowAuthoringGraphValidator | undefined;
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
      options.executableCompiler !== undefined ||
      options.validateAuthoringGraph !== undefined ||
      options.portableCatalog !== undefined)
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
      portableCatalog: options.portableCatalog,
      compatibilityRelease,
      definitionCatalog,
      placementDefinitionCatalog: options.placementDefinitionCatalog,
      executableCompiler: options.executableCompiler,
      validateAuthoringGraph: options.validateAuthoringGraph,
    });
    return Object.freeze({
      selectLocked: () => Promise.resolve(selection),
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
        portableCatalog: variant.portableCatalog,
        compatibilityRelease: release,
        definitionCatalog: variant.definitionCatalog,
        placementDefinitionCatalog: variant.placementDefinitionCatalog,
        executableCompiler: variant.executableCompiler,
        validateAuthoringGraph: variant.validateAuthoringGraph,
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
    selectLocked: () => {
      const selected = selectServingCompatibilityRelease(supported);
      const variant = normalizedVariants.find(({ compatibilityRelease }) =>
        sameRelease(compatibilityRelease, selected),
      );
      if (variant === undefined)
        throw new Error('Locked compatibility release variant is unavailable');
      return Promise.resolve(variant);
    },
  });
}
