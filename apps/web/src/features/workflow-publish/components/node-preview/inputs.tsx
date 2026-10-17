import type { NodeValidationResponse } from '@pertexo/contracts';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  isHarmlessSetup,
  sideEffectSentence,
} from '../../model/testing/preview-observation';
export function PreviewInputFields({
  nodeId,
  priorPreview,
  usePrior,
  onUsePriorChange,
  input,
  onInputChange,
}: Readonly<{
  nodeId: string;
  priorPreview: Readonly<{ id: string; stepName: string }> | undefined;
  usePrior: boolean;
  onUsePriorChange: (value: boolean) => void;
  input: string;
  onInputChange: (value: string) => void;
}>) {
  return (
    <>
      {priorPreview === undefined ? null : (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Use the output from testing {priorPreview.stepName}</span>
          <Switch checked={usePrior} onCheckedChange={onUsePriorChange} />
        </label>
      )}
      {usePrior ? null : (
        <Field>
          <FieldLabel htmlFor={`test-input-${nodeId}`}>
            Sample input (JSON)
          </FieldLabel>
          <Textarea
            id={`test-input-${nodeId}`}
            name="previewInput"
            autoComplete="off"
            spellCheck={false}
            className="min-h-24 font-mono"
            value={input}
            onChange={(event) => {
              onInputChange(event.target.value);
            }}
          />
        </Field>
      )}
    </>
  );
}
export function RealTestPermission({
  stepSideEffect,
  check,
  acknowledged,
  onAcknowledgedChange,
}: Readonly<{
  stepSideEffect: string | undefined;
  check: NodeValidationResponse | undefined;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
}>) {
  const harmless = isHarmlessSetup(check);
  return (
    <Field>
      <FieldDescription>
        {sideEffectSentence(stepSideEffect, check?.disclosure)}
      </FieldDescription>
      {harmless ? null : (
        <label className="flex items-center justify-between gap-3 text-sm font-medium">
          <span>I understand this test runs for real</span>
          <Switch
            checked={acknowledged}
            onCheckedChange={(checked) => {
              onAcknowledgedChange(checked);
            }}
          />
        </label>
      )}
    </Field>
  );
}
