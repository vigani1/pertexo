import {
  API_TOKEN_ACTIVE_LIMIT,
  type ApiTokenMetadata,
  type ApiTokenScope,
} from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';
import { isApiError } from '@/lib/api/error';
import { describeCommandError, isUncertainOutcome } from '@/lib/api/error-copy';

export const SCOPE_COPY: Readonly<
  Record<ApiTokenScope, { label: string; description: string }>
> = {
  'workflow:read': {
    label: 'Read workflows',
    description: 'List, inspect and export saved workflows.',
  },
  'workflow:create': {
    label: 'Create workflows',
    description:
      'Create a blank workflow, or preview an import and create its unpublished copy.',
  },
  'workflow:update': {
    label: 'Edit workflows and tables',
    description:
      'Save drafts, update pause settings and tags, control schedules, provision webhooks, and write table columns and rows.',
  },
  'workflow:publish': {
    label: 'Publish and control workflows',
    description:
      'Publish a reviewed draft, archive or restore a workflow, and resume automatic triggers.',
  },
  'run:read': {
    label: 'Read runs',
    description: 'List runs and inspect their status.',
  },
  'run:read-data': {
    label: 'Read run data',
    description:
      "Read a run's input and what each step received and returned, which can be sensitive.",
  },
  'run:start': {
    label: 'Start runs',
    description: 'Execute a published workflow with real effects.',
  },
  'run:cancel': {
    label: 'Cancel runs',
    description: 'Request cancellation of a run.',
  },
  'workspace:read': {
    label: 'Read workspace data',
    description:
      'Read table definitions and rows, and non-secret workspace variables.',
  },
  'variable:manage': {
    label: 'Edit workspace variables',
    description:
      'Replace non-secret workspace variables at the revision you read.',
  },
  'connection:read': {
    label: 'Read connections',
    description:
      'List connections and resolve bindings during an import. Never reveals secrets.',
  },
};
export const TOKEN_STATUS: Readonly<
  Record<ApiTokenMetadata['status'], { tone: StatusTone; label: string }>
> = {
  active: { tone: 'success', label: 'Active' },
  expired: { tone: 'skipped', label: 'Expired' },
  revoked: { tone: 'canceled', label: 'Revoked' },
  membership_changed: { tone: 'attention', label: 'Membership changed' },
};

export function tokenCommandFeedback(cause: unknown, action: string) {
  if (isApiError(cause)) {
    if (cause.problem?.code === 'auth.session_not_fresh')
      return {
        message:
          'For your security, sign in again, then create within five minutes.',
        freshSignIn: true,
      };
    if (cause.problem?.code === 'api_token.unavailable')
      return {
        message:
          'Automation tokens are disabled on this server. Ask the person running Pertexo to enable them.',
        freshSignIn: false,
      };
    if (cause.problem?.code === 'api_token.limit')
      return {
        message: `You can have ${String(API_TOKEN_ACTIVE_LIMIT)} active tokens here. Revoke an unused one before creating another.`,
        freshSignIn: false,
      };
  }
  return { message: describeCommandError(cause, action), freshSignIn: false };
}
export function uncertainTokenOutcome(cause: unknown): boolean {
  return (
    isUncertainOutcome(cause) ||
    (isApiError(cause) &&
      (cause.status ?? 0) >= 500 &&
      cause.problem?.code !== 'api_token.unavailable' &&
      cause.problem?.code !== 'request.rate_limit_unavailable')
  );
}
