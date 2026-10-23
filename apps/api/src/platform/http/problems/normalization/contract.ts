import type { projectConcurrencyConflict } from '../concurrency-conflict.js';
import type { ConcurrencyConflict } from '../concurrency-conflict.js';
import type {
  ApiProblem,
  ApiProblemIssue,
  workflowRecoveryRefusalSchema,
} from '@pertexo/contracts';
import type {
  WorkflowLifecycleConflictProblem,
  WorkflowNameConflictProblem,
  WorkflowRevisionConflictProblem,
} from '@pertexo/contracts';

import type {
  ApplicationError,
  ApplicationErrorCatalogEntry,
  ApplicationErrorCode,
} from '../../application-error.js';
import type {
  HttpRequestLike,
  HttpResponseLike,
} from '../../request-context.js';

import type {
  AutoPauseConflictProblem,
  AutoPauseConflictRevision,
} from '../auto-pause-conflict.js';

export type ProblemIssue = ApiProblemIssue;

export type ProblemDetails =
  | ApiProblem
  | WorkflowRevisionConflictProblem
  | WorkflowLifecycleConflictProblem
  | WorkflowNameConflictProblem
  | AutoPauseConflictProblem
  | ReturnType<typeof projectConcurrencyConflict>;

export type HttpErrorLogEntry = Readonly<{
  code: ApplicationErrorCode;
  requestId: string;
  severity: ApplicationErrorCatalogEntry['severity'];
  actorId?: string;
  workspaceId?: string;
  instance?: string;
  cause: unknown;
}>;

export interface HttpErrorLogger {
  log(entry: HttpErrorLogEntry): void | Promise<void>;
}

export type HttpApplicationErrorMapper = (
  error: unknown,
  request: HttpRequestLike,
) => ApplicationError | undefined;

export type ProblemResponse = HttpResponseLike & {
  code?: (status: number) => unknown;
  status?: (status: number) => unknown;
  send?: (body: ProblemDetails) => unknown;
  json?: (body: ProblemDetails) => unknown;
};

export type NormalizedProblem = Readonly<{
  code: ApplicationErrorCode;
  status: number;
  title: string;
  detail?: string;
  errors?: readonly ProblemIssue[];
  revisionConflict?: Readonly<{
    currentRevision: number;
    currentEtag: string;
  }>;
  retryAfterSeconds?: number;
  currentLifecycleRevision?: number;
  currentNameRevision?: number;
  autoPauseConflict?: AutoPauseConflictRevision;
  concurrencyConflict?: ConcurrencyConflict;
  recoveryReason?: ReturnType<
    typeof workflowRecoveryRefusalSchema.parse
  >['reason'];
  cause?: unknown;
}>;
