import type { z } from 'zod';
import {
  DRAFT_PROPOSAL_TIMING,
  PROPOSAL_CORRECTION_ROUNDS,
  type draftProposalRequestSchema,
} from '@pertexo/contracts';
import {
  WorkflowNotFoundError,
  type WorkflowAuthoringStore,
} from '@pertexo/core/authoring';
import { generatePersistedId } from '@pertexo/database/platform';
import { runModelOnce } from '@pertexo/integrations/server';
import type { ModelUsage } from '@pertexo/node-sdk';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import type { ListNodeDefinitionsService } from '../../catalog/index.js';
import type { ConnectionLookupDependencies } from '../../connections/lookups/lookup-options.service.js';
import { storeContext } from '../../workspaces/request/caller.js';
import {
  assistantDisclosure,
  ASSISTANT_TIMEOUT_MILLIS,
  failureOutcome,
  modelCost,
  prepareAssistant,
  type AssistantCaller,
  type ModelRates,
} from '../assistant-inference.js';
import {
  serializeWorkflowDraft,
  serializeWorkflowValidation,
} from '../http/serializers.js';
import { inspectProposalCandidate } from './inspect-proposal-candidate.js';
import {
  projectDraftForModel,
  protectedSettingRefusal,
} from './masked-draft.js';
import { expandProposalCatalog, proposalCatalog } from './proposal-catalog.js';
import {
  proposalAnswer,
  proposalAnswerSchema,
  proposalPrompt,
  proposalRequestText,
} from './proposal-prompt.js';

const PURPOSE = 'propose_draft';
const PROPOSAL_MAX_OUTPUT_TOKENS = 4_096;
const PROPOSAL_PROMPT_BYTES = 24_576;

type ProposalCaller = AssistantCaller & { workflowId: string };
type Persistence = Pick<
  WorkflowAuthoringStore,
  'assistantSettings' | 'explanations' | 'getDraft' | 'inspectCandidate'
>;

type PreparedAssistant = Extract<
  Awaited<ReturnType<typeof prepareAssistant>>,
  { kind: 'ready' }
>;
interface ProposalBudget {
  readonly deadlineAt: Date;
  readonly signal: AbortSignal;
  readonly usages: ModelUsage[];
}
type CandidateInspection = Awaited<ReturnType<typeof inspectProposalCandidate>>;

export class ProposeDraftService {
  private readonly now: () => number;
  constructor(
    private readonly persistence: Persistence,
    private readonly connection: ConnectionLookupDependencies | undefined,
    private readonly catalog: ListNodeDefinitionsService,
    private readonly options: {
      rates?: ModelRates | undefined;
      now?: () => number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async disclosure(input: ProposalCaller) {
    const signal = AbortSignal.timeout(ASSISTANT_TIMEOUT_MILLIS);
    const { prepared } = await this.prepare(input, signal);
    return prepared.kind === 'ready'
      ? assistantDisclosure(prepared, signal)
      : prepared;
  }

  async propose(
    input: ProposalCaller,
    { confirmation, request }: z.output<typeof draftProposalRequestSchema>,
  ) {
    const deadlineAt = new Date(
      this.now() + DRAFT_PROPOSAL_TIMING.generationMillis,
    );
    const signal = AbortSignal.timeout(DRAFT_PROPOSAL_TIMING.generationMillis);
    const preparation = await this.prepare(input, signal).catch(
      (error: unknown) => {
        if (signal.aborted) return undefined;
        throw error;
      },
    );
    if (preparation === undefined) return { kind: 'timeout' as const };
    const { prepared, draft } = preparation;
    if (prepared.kind !== 'ready') return prepared;
    if (prepared.confirmation !== confirmation)
      return { kind: 'confirmation_changed' as const };
    const requestText = proposalRequestText(request);
    const catalog = proposalCatalog(this.catalog, requestText, draft.graphJson);
    const currentDraft = projectDraftForModel(
      draft.graphJson,
      this.catalog.assistantDisclosure,
    );
    const prompt = (query?: string) => {
      if (query === undefined)
        return proposalPrompt({ currentDraft, catalog, request: requestText });
      const { entries, found } = expandProposalCatalog(
        this.catalog,
        draft.graphJson,
        catalog,
        query,
      );
      return proposalPrompt({
        currentDraft,
        catalog: entries,
        request: requestText,
        lookup: found ? 'found' : 'no_matches',
      });
    };
    const requestId = generatePersistedId();
    const usages: ModelUsage[] = [];
    const actor = { ...storeContext(input), workflowId: input.workflowId };
    const outcome = await this.infer(prepared, prompt, {
      deadlineAt,
      signal,
      usages,
      inspect: (graph) =>
        inspectProposalCandidate(this.persistence, this.catalog, {
          graph,
          draft,
          actor,
          signal,
        }),
    }).finally(async () => {
      const usage = summarizeUsage(prepared.model, usages);
      await this.persistence.explanations.recordUsage({
        ...actor,
        target: { purpose: PURPOSE, workflowId: input.workflowId },
        requestId,
        usage,
        costNanoDollars: modelCost(usage, this.options.rates),
      });
    });
    const { result, rounds } = outcome;
    const usage = summarizeUsage(prepared.model, usages);
    if (result.kind === 'rejected')
      return { kind: result.kind, issues: result.issues, rounds, usage };
    if (result.kind !== 'inspected') return { ...result, rounds, usage };
    return {
      kind: 'inspected' as const,
      base: (await serializeWorkflowDraft(result.base)).body,
      draft: (await serializeWorkflowDraft(result.draft)).body,
      representationTag: result.representationTag,
      validation: serializeWorkflowValidation(
        result.draft,
        result.validation,
        null,
      ).body,
      rounds,
      usage,
    };
  }

  private async prepare(input: ProposalCaller, signal: AbortSignal) {
    const { workspaceId, actorId } = storeContext(input);
    const draft = await this.persistence.getDraft(
      workspaceId,
      input.workflowId,
      actorId,
      signal,
    );
    if (draft === null)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const prepared = await prepareAssistant(
      {
        settings: this.persistence.assistantSettings,
        connection: this.connection,
      },
      input,
      { purpose: PURPOSE, subject: [input.workflowId, draft.revision], signal },
    );
    return { prepared, draft };
  }

  private async infer(
    prepared: PreparedAssistant,
    buildPrompt: (catalogQuery?: string) => string,
    {
      inspect,
      ...budget
    }: ProposalBudget & {
      readonly inspect: (graph: unknown) => Promise<CandidateInspection>;
    },
  ) {
    let prompt = buildPrompt();
    if (Buffer.byteLength(prompt) > PROPOSAL_PROMPT_BYTES)
      return { result: { kind: 'request_too_large' as const }, rounds: 0 };
    let rounds = 0;
    let maxOutputTokens = PROPOSAL_MAX_OUTPUT_TOKENS;
    let lastCandidate: CandidateInspection | undefined;
    let correction = '';
    let lookupUsed = false;
    for (;;) {
      const turn = await this.modelTurn(prepared, `${prompt}${correction}`, {
        ...budget,
        maxOutputTokens,
      });
      if (turn.kind === 'catalog_lookup') {
        maxOutputTokens -= turn.outputTokens;
        if (lookupUsed || maxOutputTokens <= 0)
          return {
            result: lastCandidate ?? { kind: 'invalid_response' as const },
            rounds,
          };
        lookupUsed = true;
        prompt = buildPrompt(turn.query);
        if (Buffer.byteLength(`${prompt}${correction}`) > PROPOSAL_PROMPT_BYTES)
          return {
            result: lastCandidate ?? { kind: 'request_too_large' as const },
            rounds,
          };
        continue;
      }
      if (turn.kind !== 'graph') {
        const result =
          turn.kind === 'invalid_response' || turn.kind === 'request_too_large'
            ? (lastCandidate ?? turn)
            : turn;
        return { result, rounds };
      }

      const candidate = await inspect(turn.graph);
      lastCandidate = candidate;
      maxOutputTokens -= turn.outputTokens;
      if (
        rounds === PROPOSAL_CORRECTION_ROUNDS ||
        maxOutputTokens <= 0 ||
        !('feedback' in candidate) ||
        candidate.feedback.length === 0
      )
        return { result: candidate, rounds };

      const feedback = JSON.stringify({
        ...('previousGraph' in candidate
          ? { previousGraph: candidate.previousGraph }
          : {}),
        issues: candidate.feedback.map(({ path, code, message }) => ({
          path,
          code,
          message,
        })),
      });
      correction = `\nFix the listed issues while retaining the requested changes. Return the complete corrected graph in draft.\n${feedback}`;
      if (Buffer.byteLength(`${prompt}${correction}`) > PROPOSAL_PROMPT_BYTES)
        return { result: candidate, rounds };
      rounds += 1;
    }
  }

  private async modelTurn(
    prepared: PreparedAssistant,
    prompt: string,
    {
      deadlineAt,
      signal,
      usages,
      maxOutputTokens,
    }: ProposalBudget & { readonly maxOutputTokens: number },
  ) {
    let usage: ModelUsage | undefined;
    try {
      if (signal.aborted) return { kind: 'timeout' as const };
      const answer = await runModelOnce({
        client: prepared.client,
        config: {
          mode: 'structured',
          model: prepared.model,
          outputSchema: proposalAnswerSchema,
          timeoutMillis: DRAFT_PROPOSAL_TIMING.generationMillis,
          maxOutputTokens,
        },
        prompt,
        purpose: PURPOSE,
        now: this.now,
        invocation: prepared.invocation(deadlineAt, (value) => {
          usage = value;
        }),
      });
      const parsed = proposalAnswer.safeParse(answer);
      if (!parsed.success) return { kind: 'invalid_response' as const };
      const outputTokens = usage?.outputTokens ?? maxOutputTokens;
      if (parsed.data.maskedSetting === true)
        return {
          kind: 'rejected' as const,
          issues: [protectedSettingRefusal],
        };
      return parsed.data.catalogLookup === undefined
        ? { kind: 'graph' as const, graph: parsed.data.draft, outputTokens }
        : {
            kind: 'catalog_lookup' as const,
            query: parsed.data.catalogLookup,
            outputTokens,
          };
    } catch (error: unknown) {
      if (signal.aborted) return { kind: 'timeout' as const };
      if (!(error instanceof NodeExecutorFailure)) throw error;
      return {
        kind:
          error.safeErrorCode === 'model.request_too_large'
            ? 'request_too_large'
            : failureOutcome(error),
      } as const;
    } finally {
      if (usage !== undefined) usages.push(usage);
    }
  }
}

function summarizeUsage(
  model: string,
  usages: readonly ModelUsage[],
): ModelUsage {
  const sum = (field: 'inputTokens' | 'outputTokens') => {
    const counts = usages.flatMap((usage) => usage[field] ?? []);
    const total = counts.reduce((a, b) => a + b, 0);
    return counts.length > 0 && Number.isSafeInteger(total) ? total : null;
  };
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  return inputTokens !== null &&
    outputTokens !== null &&
    usages.every(({ kind }) => kind === 'complete')
    ? { kind: 'complete', model, inputTokens, outputTokens }
    : { kind: 'incomplete', model, inputTokens, outputTokens };
}
