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
  help: { type: 'boolean' },
} as const;
const id = workflowIdentifierSchema.transform((value) => value.toLowerCase());
const workspace = { workspaceId: id };
const target = { ...workspace, workflowId: id };
const body = { bodyFile: z.string().min(1).max(4_096) };
const commandSchema = z.discriminatedUnion('operation', [
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
      'Use a supported command and named options. Run automation --help. Tokens are accepted only through PERTEXO_API_TOKEN.',
    );
  }
}
export function parseAutomationArguments(
  args: string[],
): AutomationArguments | 'help' {
  const flags = parseFlags(args);
  const seen = new Set<string>();
  for (const token of flags.tokens)
    if (token.kind === 'option') {
      if (seen.has(token.name))
        return invalidArgument('Each option can be supplied only once.');
      seen.add(token.name);
    }
  if (flags.values.help === true || args.length === 0) return 'help';
  if (flags.positionals.length !== 2)
    return invalidArgument(
      'Use one command group and action. Run automation --help.',
    );
  const operation = flags.positionals.join(' ');
  const values = flags.values;
  const input: Record<string, unknown> = {
    operation,
    workspaceId: values.workspace,
  };
  const queryCommand =
    operation === 'workflows list' ||
    operation === 'workflows versions' ||
    operation === 'runs list';
  const query: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (name === 'workspace' || name === 'help') continue;
    if (queryCommand && (name === 'limit' || name === 'after'))
      query[name] = value;
    else if (operation === 'workflows versions' && name === 'version')
      query.versionId = value;
    else if (operation === 'runs list' && name === 'workflow')
      query.workflowId = value;
    else input[fieldNames[name] ?? name] = value;
  }
  if (queryCommand) input.query = query;
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success)
    return invalidArgument(
      'The command needs valid workspace/target UUIDs and only its documented options. Writes require their stable --key, reviewed --etag and/or --body file. Run automation --help.',
    );
  return parsed.data;
}
