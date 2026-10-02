export type WorkflowOrganizationConfig = Readonly<{
  /** Canonical base64, decoded once by the organization runtime owner. */
  cursorSigningKey: string;
}>;

const KEY_NAME = 'WORKFLOW_ORGANIZATION_CURSOR_KEY';
const OTHER_SECRET_NAMES = [
  'OIDC_TRANSACTION_KEY',
  'INVITATION_TOKEN_KEY',
  'AUTH_MAIL_KEY',
  'BETTER_AUTH_SECRET',
] as const;

/** Optional capability; never borrow identity keys or synthesize local secrets. */
export function parseWorkflowOrganizationConfig(
  environment: Record<string, string | undefined>,
  otherKeyValues: readonly string[] = [],
): WorkflowOrganizationConfig | undefined {
  const configuredNames = Object.entries(environment).flatMap(
    ([name, value]) =>
      value !== undefined && name.startsWith('WORKFLOW_ORGANIZATION_')
        ? [name]
        : [],
  );
  if (configuredNames.length === 0) return undefined;
  const key = environment[KEY_NAME];
  if (
    configuredNames.some((name) => name !== KEY_NAME) ||
    key?.length !== 44 ||
    !/^[A-Za-z0-9+/]{43}=$(?![\s\S])/u.test(key) ||
    Buffer.from(key, 'base64').byteLength !== 32 ||
    Buffer.from(key, 'base64').toString('base64') !== key ||
    [
      ...OTHER_SECRET_NAMES.map((name) => environment[name]),
      ...otherKeyValues,
    ].some(
      (value) =>
        value !== undefined &&
        (value === key ||
          Buffer.from(value, 'base64').equals(Buffer.from(key, 'base64'))),
    )
  )
    throw new Error('Workflow organization configuration is invalid');
  return Object.freeze({ cursorSigningKey: key });
}
