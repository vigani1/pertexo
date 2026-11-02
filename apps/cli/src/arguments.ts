import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  idempotencyKeySchema,
  strongEtagSchema,
  workflowIdentifierSchema,
  workflowListQuerySchema,
  workflowVersionsQuerySchema,
  workflowRunListQuerySchema,
} from '@pertexo/contracts';
import { invalidArgument } from './errors.js';

const options = {
  workspace: { type: 'string' },
  workflow: { type: 'string' },
  run: { type: 'string' },
  version: { type: 'string' },
  body: { type: 'string' },
  key: { type: 'string' },
  etag: { type: 'string' },
  limit: { type: 'string' },
  after: { type: 'string' },
  status: { type: 'string' },
  timeout: { type: 'string' },
  help: { type: 'boolean' },
} as const;
const id = workflowIdentifierSchema.transform((value) => value.toLowerCase());
const workspace = { workspaceId: id };
const target = { ...workspace, workflowId: id };
const body = { bodyFile: z.string().min(1).max(4_096) };
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('whoami'), ...workspace }).strict(),
  z
    .object({
      operation: z.literal('workflows list'),
      ...workspace,
      query: workflowListQuerySchema,
    })
    .strict(),
  z
    .object({
      operation: z.enum(['workflows get', 'workflows draft']),
      ...target,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflows versions'),
      ...target,
      query: workflowVersionsQuerySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflows export'),
      ...target,
      ...body,
      etag: strongEtagSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflows import-preview'),
      ...workspace,
      ...body,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflows import'),
      ...workspace,
      ...body,
      key: idempotencyKeySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('workflows publish'),
      ...target,
      etag: strongEtagSchema,
      key: idempotencyKeySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('runs start'),
      ...target,
      bodyFile: body.bodyFile.optional(),
      key: idempotencyKeySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('runs list'),
      ...workspace,
      query: workflowRunListQuerySchema,
    })
    .strict(),
  z
    .object({ operation: z.literal('runs get'), ...workspace, runId: id })
    .strict(),
  z
    .object({
      operation: z.literal('runs wait'),
      ...workspace,
      runId: id,
      timeoutSeconds: z.coerce.number().int().min(1).max(86_400).default(300),
    })
    .strict(),
  z
    .object({
      operation: z.literal('runs cancel'),
      ...workspace,
      runId: id,
      bodyFile: body.bodyFile.optional(),
    })
    .strict(),
]);
export type AutomationArguments = z.output<typeof commandSchema>;
const fieldNames: Readonly<Record<string, string>> = {
  workflow: 'workflowId',
  run: 'runId',
  body: 'bodyFile',
  timeout: 'timeoutSeconds',
};
const flagNames: Readonly<Record<string, string>> = {
  workspaceId: '--workspace',
  workflowId: '--workflow',
  runId: '--run',
  bodyFile: '--body',
  timeoutSeconds: '--timeout',
  versionId: '--version',
  key: '--key',
  etag: '--etag',
  limit: '--limit',
  after: '--after',
  status: '--status',
};
function parseFlags(args: string[]) {
  try {
    return parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    return invalidArgument(
      'Use a supported command and named options. Run pertexo --help. Tokens are accepted only through PERTEXO_API_TOKEN.',
    );
  }
}
/** The token names its workspace, so `--workspace` defaults to it; run.ts refuses a mismatch. */
export function parseAutomationArguments(
  args: string[],
  tokenWorkspaceId?: string,
): AutomationArguments | 'help' | 'version' {
  // Alone it asks the CLI's version; workflows versions takes a --version UUID.
  if (args.length === 1 && args[0] === '--version') return 'version';
  const flags = parseFlags(args);
  assertUniqueOptions(flags);
  if ((flags.values.help ?? false) || args.length === 0) return 'help';
  const whoami = flags.positionals.join(' ') === 'whoami';
  if (!whoami && flags.positionals.length !== 2)
    return invalidArgument(
      'Use one command group and action. Run pertexo --help.',
    );
  const operation = flags.positionals.join(' ');
  const values = flags.values;
  const input: Record<string, unknown> = {
    operation,
    workspaceId: values.workspace ?? tokenWorkspaceId,
  };
  const queryCommand =
    operation === 'workflows list' ||
    operation === 'workflows versions' ||
    operation === 'runs list';
  const query: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (name === 'workspace' || name === 'help') continue;
    const queryField = automationQueryField({ name, operation, queryCommand });
    if (queryField === undefined) input[fieldNames[name] ?? name] = value;
    else query[queryField] = value;
  }
  if (queryCommand) input.query = query;
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) return invalidArgument(describeIssue(parsed.error));
  return parsed.data;
}

function describeIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue?.code === 'unrecognized_keys') {
    const names = issue.keys.map((key) => flagNames[key] ?? `--${key}`);
    return `${names.join(', ')} isn't an option for this command. Run pertexo --help.`;
  }
  const field = issue?.path.at(-1);
  if (field === 'operation') return "That isn't a command. Run pertexo --help.";
  const flag = typeof field === 'string' ? flagNames[field] : undefined;
  return flag === undefined
    ? 'The options are invalid. Run pertexo --help.'
    : `${flag} is missing or invalid. Run pertexo --help.`;
}

function assertUniqueOptions(flags: ReturnType<typeof parseFlags>): void {
  const seen = new Set<string>();
  for (const token of flags.tokens)
    if (token.kind === 'option') {
      if (seen.has(token.name))
        return invalidArgument('Each option can be supplied only once.');
      seen.add(token.name);
    }
}

function automationQueryField(input: {
  readonly name: string;
  readonly operation: string;
  readonly queryCommand: boolean;
}): string | undefined {
  const { name, operation, queryCommand } = input;
  if (!queryCommand) return undefined;
  if (name === 'limit' || name === 'after') return name;
  switch (operation) {
    case 'workflows versions':
      return name === 'version' ? 'versionId' : undefined;
    case 'runs list':
      if (name === 'status') return name;
      return name === 'workflow' ? 'workflowId' : undefined;
    default:
      return undefined;
  }
}
