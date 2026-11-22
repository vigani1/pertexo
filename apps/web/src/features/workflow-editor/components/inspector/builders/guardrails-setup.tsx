import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel, LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { formatCount } from '@/lib/format/count';
import {
  GUARDRAILS_LIMITS,
  guardrailsDraftChecksSchema,
  guardrailsTermsSchema,
  type GuardrailsCheck,
} from '@pertexo/integrations';
import { type NodeConfig } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { useInspectorDraftField } from '../use-draft-field';

const checks = [
  { kind: 'pii', label: 'Personal information' },
  { kind: 'prohibited_terms', label: 'Prohibited terms' },
  { kind: 'injection', label: 'Prompt injection markers' },
] as const;

const termsField = 'guardrails-terms';

export function GuardrailsSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const enabled = guardrailsDraftChecksSchema.safeParse(config.checks);
  if (!enabled.success)
    return (
      <p className="text-sm text-muted-foreground">
        Edit this check configuration in JSON.
      </p>
    );
  const termsCheck = enabled.data.find(
    ({ kind }) => kind === 'prohibited_terms',
  );
  return (
    <div className="flex flex-col gap-3">
      {checks.map(({ kind, label }) => (
        <Field key={kind}>
          <FieldLabel className="flex items-center gap-2">
            <Checkbox
              checked={enabled.data.some((check) => check.kind === kind)}
              disabled={!form.editable}
              onCheckedChange={(checked) => {
                if (!checked && kind === 'prohibited_terms')
                  form.reportScratch(termsField, false);
                updateChecks(
                  form,
                  kind,
                  checked
                    ? kind === 'prohibited_terms'
                      ? { kind, terms: [] }
                      : { kind }
                    : undefined,
                );
              }}
            />
            {label}
          </FieldLabel>
        </Field>
      ))}
      {termsCheck?.kind === 'prohibited_terms' ? (
        <ProhibitedTerms terms={termsCheck.terms} form={form} />
      ) : null}
    </div>
  );
}

function updateChecks(
  form: NodeFormApi,
  kind: GuardrailsCheck['kind'],
  next: GuardrailsCheck | undefined,
) {
  form.commit((node) => {
    const read = guardrailsDraftChecksSchema.safeParse(node.config.checks);
    if (!read.success) return {};
    const current = read.data.filter((check) => check.kind !== kind);
    return {
      config: {
        ...node.config,
        checks: next === undefined ? current : [...current, next],
      },
    };
  }, `${form.nodeId}:guardrails:${kind}`);
}

function ProhibitedTerms({
  terms,
  form,
}: Readonly<{ terms: readonly string[]; form: NodeFormApi }>) {
  const field = useInspectorDraftField({
    value: terms,
    format: (values) => values.join('\n'),
    equals: (left, right) => left.join('\n') === right.join('\n'),
    parse: (text) => {
      const parsed = guardrailsTermsSchema.safeParse(
        text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error: `Enter up to ${formatCount(GUARDRAILS_LIMITS.terms, 'term')}, each up to ${formatCount(GUARDRAILS_LIMITS.termCharacters, 'character')}.`,
          };
    },
    commit: (next) =>
      updateChecks(form, 'prohibited_terms', {
        kind: 'prohibited_terms',
        terms: [...next],
      }),
    onScratchChange: (scratch) => form.reportScratch(termsField, scratch),
  });
  return (
    <LabelledField
      id={fieldControlId(form.nodeId, termsField)}
      label="Prohibited terms list"
      description="Enter one word or phrase per line."
      error={field.error}
    >
      {(control) => (
        <Textarea
          {...control}
          rows={3}
          disabled={!form.editable}
          value={field.text}
          onChange={(event) => field.change(event.target.value)}
          onBlur={field.blur}
        />
      )}
    </LabelledField>
  );
}
