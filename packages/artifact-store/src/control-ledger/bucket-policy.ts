function actionPatternMatches(pattern: string, action: string): boolean {
  const expression = pattern
    .replaceAll(/[.+?^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${expression}$`, 'iu').test(action);
}

function values(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return [];
}

function resourceCoversLedger(resource: string, bucket: string): boolean {
  const requiredPrefix = `arn:aws:s3:::${bucket}/control-ledger/`;
  if (!resource.endsWith('*')) return false;
  const coveredPrefix = resource.slice(0, -1);
  return (
    coveredPrefix.startsWith(`arn:aws:s3:::${bucket}/`) &&
    requiredPrefix.startsWith(coveredPrefix)
  );
}

function isMissingIfNoneMatchCondition(condition: unknown): boolean {
  if (typeof condition !== 'object' || condition === null) return false;
  const operators = Object.entries(condition as Record<string, unknown>);
  if (operators.length !== 1 || operators[0]?.[0] !== 'Null') return false;
  const nullCondition = operators[0][1];
  if (typeof nullCondition !== 'object' || nullCondition === null) return false;
  const entries = Object.entries(nullCondition as Record<string, unknown>);
  // IAM Null with "true" matches requests where this condition key is absent.
  return (
    entries.length === 1 &&
    entries[0]?.[0] === 's3:if-none-match' &&
    entries[0][1] === 'true'
  );
}

export function inspectControlLedgerBucketPolicy(
  policyText: string,
  bucket: string,
): Readonly<{ deletesDenied: boolean; missingIfNoneMatchDenied: boolean }> {
  let policy: unknown;
  try {
    policy = JSON.parse(policyText) as unknown;
  } catch {
    return { deletesDenied: false, missingIfNoneMatchDenied: false };
  }
  if (typeof policy !== 'object' || policy === null) {
    return { deletesDenied: false, missingIfNoneMatchDenied: false };
  }
  const statementValue = (policy as { readonly Statement?: unknown }).Statement;
  const statements = Array.isArray(statementValue)
    ? statementValue
    : [statementValue];
  const requiredActions = new Set([
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:ReplicateDelete',
    's3:ReplicateObject',
  ]);
  let missingIfNoneMatchDenied = false;
  for (const statement of statements) {
    if (typeof statement !== 'object' || statement === null) continue;
    const candidate = statement as {
      readonly Action?: unknown;
      readonly Condition?: unknown;
      readonly Effect?: unknown;
      readonly Principal?: unknown;
      readonly Resource?: unknown;
    };
    const coversLedger = values(candidate.Resource).some((resource) =>
      resourceCoversLedger(resource, bucket),
    );
    if (
      candidate.Effect !== 'Deny' ||
      candidate.Principal !== '*' ||
      !coversLedger
    ) {
      continue;
    }
    if (candidate.Condition === undefined) {
      for (const required of requiredActions) {
        if (
          values(candidate.Action).some((pattern) =>
            actionPatternMatches(pattern, required),
          )
        ) {
          requiredActions.delete(required);
        }
      }
    }
    if (
      isMissingIfNoneMatchCondition(candidate.Condition) &&
      values(candidate.Action).some((pattern) =>
        actionPatternMatches(pattern, 's3:PutObject'),
      )
    ) {
      missingIfNoneMatchDenied = true;
    }
  }
  return {
    deletesDenied: requiredActions.size === 0,
    missingIfNoneMatchDenied,
  };
}
