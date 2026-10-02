import {
  createWorkflowInputCaseDatabase,
  createWorkflowTagDatabase,
  createWorkflowFavoriteDatabase,
  createWorkflowOrganizationReadDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkflowInputCaseDatabase,
} from '@pertexo/database/api';
import {
  createWorkflowFavoriteAbsenceAuthority,
  createWorkflowOrganizationCursorCodec,
  createWorkflowOrganizationPageCursorCodec,
  type WorkflowAuthoringDependencies,
} from '../../workflow-authoring/index.js';
import {
  parseWorkflowOrganizationConfig,
  type WorkflowOrganizationConfig,
} from '../config/workflow-organization-config.js';
import type { ApiWorkflowRuntimeOverrides } from './workflow-runtime.module.js';

export type ApiWorkflowMetadataRuntime = Readonly<{
  inputCases?: WorkflowInputCaseDatabase;
  organization?: NonNullable<WorkflowAuthoringDependencies['organization']>;
  close(): Promise<void>;
}>;

/** One lifecycle owner for non-executable authoring metadata. A missing dedicated
 * key leaves organization unsupported; never generate/borrow key material. */
export async function createApiWorkflowMetadataRuntime(
  config: DatabaseConfig,
  authoring: NonNullable<ApiWorkflowRuntimeOverrides['authoring']>,
  organizationConfig?: WorkflowOrganizationConfig,
  runtime?: DatabaseRuntime,
): Promise<ApiWorkflowMetadataRuntime> {
  const resources: Readonly<{ close(): Promise<void> }>[] = [];
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closePromise ??= (async () => {
      const results = await Promise.allSettled(
        resources.map((resource) =>
          Promise.resolve().then(() => resource.close()),
        ),
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Workflow metadata shutdown failed');
    })();
    return closePromise;
  }
  try {
    const lease = runtime === undefined ? {} : { runtime };
    // Preserve the existing explicitly opted-in test adapter policy.
    const inputCases =
      authoring.inputCasePersistence ??
      ((authoring.database !== undefined ||
        authoring.databaseFactory !== undefined) &&
      authoring.inputCasePersistenceFactory === undefined
        ? undefined
        : (
            authoring.inputCasePersistenceFactory ??
            createWorkflowInputCaseDatabase
          )(config, lease));
    if (inputCases !== undefined) resources.push(inputCases);
    let organization: ApiWorkflowMetadataRuntime['organization'];
    if (organizationConfig !== undefined) {
      const parsed = parseWorkflowOrganizationConfig({
        WORKFLOW_ORGANIZATION_CURSOR_KEY: organizationConfig.cursorSigningKey,
      });
      if (parsed === undefined)
        throw new TypeError('Organization configuration is missing');
      const key = Buffer.from(parsed.cursorSigningKey, 'base64');
      const absenceTokens = createWorkflowFavoriteAbsenceAuthority(key);
      const tags = createWorkflowTagDatabase(config, lease);
      resources.push(tags);
      const favorites = createWorkflowFavoriteDatabase(config, {
        ...lease,
        absenceTokens,
      });
      resources.push(favorites);
      const reader = createWorkflowOrganizationReadDatabase(config, {
        ...lease,
        absenceTokens,
      });
      resources.push(reader);
      organization = Object.freeze({
        tags,
        favorites,
        reader,
        cursors: Object.freeze({
          workflows: createWorkflowOrganizationCursorCodec(key),
          pages: createWorkflowOrganizationPageCursorCodec(key),
        }),
      });
    }
    return Object.freeze({
      ...(inputCases === undefined ? {} : { inputCases }),
      ...(organization === undefined ? {} : { organization }),
      close,
    });
  } catch (error: unknown) {
    try {
      await close();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Workflow metadata construction and cleanup failed',
      );
    }
    throw error;
  }
}
