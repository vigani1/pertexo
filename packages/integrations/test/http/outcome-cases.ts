import type {
  HttpSideEffectClass,
  SecureHttpErrorCode,
} from '../../src/server.js';

export const CLASSES = [
  'safe',
  'idempotent_with_key',
  'unsafe',
] as const satisfies readonly HttpSideEffectClass[];

type Row = readonly [safe: string, idempotentWithKey: string, unsafe: string];

// ADR 007 outcomes for each side-effect class, written as
// "<kind> <errorKind>[ same-key][ after <ms>]". An ambiguous result is retried
// for safe and keyed work and unknown for unsafe work; a definite failure that
// may have been dispatched is never retried for unsafe work; cancellation is
// unknown only when an unsafe call may have been dispatched.
export const RESPONSE_CASES: readonly (readonly [status: number, ...Row])[] = [
  [200, 'succeeded', 'succeeded', 'succeeded'],
  [299, 'succeeded', 'succeeded', 'succeeded'],
  [400, 'failed provider', 'failed provider', 'failed provider'],
  [
    401,
    'failed authentication',
    'failed authentication',
    'failed authentication',
  ],
  [
    403,
    'failed authentication',
    'failed authentication',
    'failed authentication',
  ],
  [408, 'retry timeout', 'retry timeout same-key', 'failed timeout'],
  [425, 'retry timeout', 'retry timeout same-key', 'failed timeout'],
  [
    429,
    'retry rate_limit after 1000',
    'retry rate_limit same-key after 1000',
    'failed rate_limit',
  ],
  [500, 'retry provider', 'retry provider same-key', 'unknown provider'],
  [599, 'retry provider', 'retry provider same-key', 'unknown provider'],
  [600, 'failed provider', 'failed provider', 'failed provider'],
];

type ErrorCase = readonly [
  code: SecureHttpErrorCode,
  classification: 'ambiguous' | 'definite_failure',
  possiblyDispatched: boolean,
  ...Row,
];

const AMBIGUOUS_NETWORK: Row = [
  'retry network',
  'retry network same-key',
  'unknown network',
];
const REFUSED: Row = [
  'failed configuration',
  'failed configuration',
  'failed configuration',
];

// Codes the client raises for a request it refused to send or finish.
const REFUSAL_CODES = [
  'connection_fence_failed',
  'dispatch_binding_mismatch',
  'invalid_request',
  'pagination_origin_changed',
  'pagination_navigation_invalid',
  'redirect_rejected',
  'response_encoding_rejected',
  'response_too_large',
  'ssrf_blocked',
] as const satisfies readonly SecureHttpErrorCode[];

export const ERROR_CASES: readonly ErrorCase[] = [
  ['canceled', 'definite_failure', false, 'canceled', 'canceled', 'canceled'],
  [
    'canceled',
    'definite_failure',
    true,
    'canceled',
    'canceled',
    'unknown provider',
  ],
  ['canceled', 'ambiguous', false, 'canceled', 'canceled', 'canceled'],
  ['canceled', 'ambiguous', true, 'canceled', 'canceled', 'unknown provider'],
  [
    'dispatch_evidence_failed',
    'definite_failure',
    false,
    'retry provider',
    'retry provider same-key',
    'retry provider',
  ],
  [
    'dispatch_evidence_failed',
    'definite_failure',
    true,
    'retry provider',
    'retry provider same-key',
    'failed provider',
  ],
  ['dispatch_evidence_failed', 'ambiguous', false, ...AMBIGUOUS_NETWORK],
  ['dispatch_evidence_failed', 'ambiguous', true, ...AMBIGUOUS_NETWORK],
  [
    'dns_failed',
    'definite_failure',
    false,
    'retry network',
    'retry network same-key',
    'retry network',
  ],
  [
    'dns_failed',
    'definite_failure',
    true,
    'retry network',
    'retry network same-key',
    'failed network',
  ],
  ['dns_failed', 'ambiguous', false, ...AMBIGUOUS_NETWORK],
  ['dns_failed', 'ambiguous', true, ...AMBIGUOUS_NETWORK],
  [
    'network_failed',
    'definite_failure',
    false,
    'retry network',
    'retry network same-key',
    'retry network',
  ],
  [
    'network_failed',
    'definite_failure',
    true,
    'retry network',
    'retry network same-key',
    'failed network',
  ],
  ['network_failed', 'ambiguous', false, ...AMBIGUOUS_NETWORK],
  ['network_failed', 'ambiguous', true, ...AMBIGUOUS_NETWORK],
  [
    'timed_out',
    'definite_failure',
    false,
    'retry timeout',
    'retry timeout same-key',
    'retry timeout',
  ],
  [
    'timed_out',
    'definite_failure',
    true,
    'retry timeout',
    'retry timeout same-key',
    'failed timeout',
  ],
  [
    'timed_out',
    'ambiguous',
    false,
    'retry timeout',
    'retry timeout same-key',
    'unknown timeout',
  ],
  [
    'timed_out',
    'ambiguous',
    true,
    'retry timeout',
    'retry timeout same-key',
    'unknown timeout',
  ],
  ...REFUSAL_CODES.flatMap((code): ErrorCase[] => [
    [code, 'definite_failure', false, ...REFUSED],
    [code, 'definite_failure', true, ...REFUSED],
    [code, 'ambiguous', false, ...AMBIGUOUS_NETWORK],
    [code, 'ambiguous', true, ...AMBIGUOUS_NETWORK],
  ]),
];

/** Reads the table notation; it carries no policy of its own. */
function decision(text: string) {
  const [kind = '', errorKind, ...rest] = text.split(' ');
  const after = rest.indexOf('after');
  const delay =
    after < 0 ? {} : { minimumRetryDelayMillis: Number(rest[after + 1]) };
  if (kind === 'succeeded') return { kind };
  if (kind === 'canceled') return { kind, errorKind: 'canceled' };
  if (kind === 'unknown') return { kind: 'outcome_unknown', errorKind };
  if (kind === 'retry')
    return {
      kind,
      errorKind,
      reuseProviderKey: rest.includes('same-key'),
      ...delay,
    };
  return { kind, errorKind };
}

export function expectedFor(row: Row, sideEffectClass: HttpSideEffectClass) {
  return decision(row[CLASSES.indexOf(sideEffectClass)] ?? '');
}
