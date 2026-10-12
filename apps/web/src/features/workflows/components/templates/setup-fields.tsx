import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { useFieldValidation } from '@/components/ui/use-field-validation';
import {
  setupValueError,
  type SetupTarget,
} from '../../model/templates/curated-setup';

export function CuratedSetupFields({
  targets,
  values,
  locked,
  validation,
  onChange,
}: Readonly<{
  targets: readonly SetupTarget[];
  values: readonly string[];
  locked: boolean;
  validation: ReturnType<typeof useFieldValidation<string>>;
  onChange: (index: number, value: string) => void;
}>) {
  return (
    <FieldGroup>
      {targets.map((target, index) => (
        <LabelledField
          key={`${target.nodeId}:${target.key}`}
          id={`template-setup-${String(index)}`}
          label={
            target.valueKind === 'https_endpoint'
              ? 'HTTPS endpoint'
              : 'Slack channel ID'
          }
          error={validation.error(`setup-${String(index)}`)}
          description={
            target.valueKind === 'https_endpoint'
              ? 'A lowercase https:// address with a path, such as https://example.com/hooks. No ports, passwords or tokens.'
              : 'Do not enter credentials or secrets.'
          }
        >
          {(control) => (
            <Input
              {...control}
              ref={validation.register(`setup-${String(index)}`)}
              name={`template-setup-${String(index)}`}
              type={target.valueKind === 'https_endpoint' ? 'url' : 'text'}
              spellCheck={false}
              value={values[index] ?? ''}
              maxLength={target.valueKind === 'https_endpoint' ? 2048 : 128}
              disabled={locked}
              autoComplete="off"
              onChange={(event) => {
                if (locked) return;
                onChange(index, event.target.value);
                validation.change(
                  `setup-${String(index)}`,
                  setupValueError(target, event.target.value),
                );
              }}
            />
          )}
        </LabelledField>
      ))}
      <p className="text-sm text-muted-foreground">
        Pertexo remembers which example this draft started from. Your later
        edits don’t change the example.
      </p>
    </FieldGroup>
  );
}
