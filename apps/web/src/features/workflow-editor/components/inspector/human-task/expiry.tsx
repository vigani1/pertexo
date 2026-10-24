import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useInspectorDraftField } from '../use-draft-field';
import type { NodeFormApi } from '../../../model/inspector/node-form';
export function ExpiryField({
  seconds,
  form,
}: Readonly<{ seconds: number; form: NodeFormApi }>) {
  const field = useInspectorDraftField({
    value: seconds,
    format: (value) => String(value / 3600),
    parse: (text) => {
      const value = Math.round(Number(text) * 3600);
      const invalidExpiry =
        text.trim() === '' ||
        !Number.isSafeInteger(value) ||
        value < 3600 ||
        value > 2592000;
      return invalidExpiry
        ? { ok: false, error: 'Enter from 1 to 720 hours (30 days).' }
        : { ok: true, value };
    },
    commit: (value) => {
      form.commit(
        (node) => ({ config: { ...node.config, expiresAfterSeconds: value } }),
        `${form.nodeId}:approval:expiry`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch('approval-expiry', scratch);
    },
  });
  return (
    <LabelledField
      id={`${form.nodeId}-approval-expiry`}
      label="Expires after (hours)"
      description="168 hours is 7 days, the default. From 1 hour to 30 days. Expiry fails this step; a failure route can handle it."
      error={field.error}
    >
      {(control) => (
        <Input
          {...control}
          type="number"
          min={1}
          max={720}
          step="any"
          value={field.text}
          disabled={!form.editable}
          onChange={(event) => {
            field.change(event.target.value);
          }}
          onBlur={field.blur}
        />
      )}
    </LabelledField>
  );
}
