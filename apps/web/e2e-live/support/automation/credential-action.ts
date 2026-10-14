import { API_PROBLEM_MANIFEST } from '@pertexo/contracts';

const phases = {
  cli: 'CLI request',
  'workflow-create': 'source creation',
  'draft-save': 'source save',
  'token-create': 'CLI token creation',
  'token-revoke': 'CLI token revocation',
  'token-revocation-check': 'CLI revocation verification',
  'workflows.list': 'workflow list',
  'workflows.get': 'workflow read',
  'workflows.draft': 'draft read',
  'workflows.export': 'workflow export',
  'workflows.import-preview': 'import preview',
  'workflows.import': 'workflow import',
  'workflows.versions': 'version list',
  'workflows.publish': 'publication',
  'runs.start': 'run start',
  'runs.get': 'run read',
  'runs.list': 'run list',
  'runs.cancel': 'terminal cancellation',
} as const;

class OwnedAutomationFailure extends Error {
  readonly phase: keyof typeof phases;
  readonly code: string | undefined;
  constructor(phase: string, code: unknown) {
    const safePhase = Object.hasOwn(phases, phase)
      ? (phase as keyof typeof phases)
      : 'cli';
    const safeCode =
      typeof code === 'string' && Object.hasOwn(API_PROBLEM_MANIFEST, code)
        ? code
        : undefined;
    super(
      `Owned automation action failed during ${phases[safePhase]}${safeCode === undefined ? '' : ` (${safeCode})`}; sensitive details omitted.`,
    );
    this.phase = safePhase;
    this.code = safeCode;
  }
}

/** Only allowlisted phases and public problem codes survive; never raw errors or replies. */
export function ownedAutomationFailure(phase: string, failure: unknown): Error {
  if (failure instanceof OwnedAutomationFailure)
    return new OwnedAutomationFailure(failure.phase, failure.code);
  let code: unknown;
  try {
    if (typeof failure === 'object' && failure !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(failure, 'code');
      if (descriptor !== undefined && 'value' in descriptor)
        code = descriptor.value;
    }
  } catch {
    /* A diagnostic must not expose a hostile error accessor. */
  }
  return new OwnedAutomationFailure(phase, code);
}

/** Playwright failures can include bearer headers or a matcher snapshot of the receipt. */
export async function withOwnedCredential<Value>(
  action: () => Promise<Value>,
): Promise<Value> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof OwnedAutomationFailure)
      throw ownedAutomationFailure(error.phase, error);
    throw new Error(
      'Owned automation credential action failed; sensitive details omitted.',
    );
  }
}
