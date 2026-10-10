import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../../model/rename';
import type { CuratedTemplate } from '../../model/templates/curated-setup';
import { CuratedTemplateChoice } from '../templates/curated-template-choice';
import { CuratedSetupFields } from '../templates/setup-fields';

/** Editable source selection; reading, previewing and commands stay in the owner. */
export function WorkflowImportSourceFields({
  apiClient,
  userId,
  template,
  setupValues,
  name,
  fileGeneration,
  locked,
  validation,
  onChooseTemplate,
  onChooseFile,
  onNameChange,
  onSetupChange,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  template: CuratedTemplate | undefined;
  setupValues: readonly string[];
  name: string;
  fileGeneration: number;
  locked: boolean;
  validation: ReturnType<typeof useFieldValidation<string>>;
  onChooseTemplate: (template: CuratedTemplate) => void;
  onChooseFile: (file: File | undefined) => void;
  onNameChange: (name: string) => void;
  onSetupChange: (index: number, value: string) => void;
}>) {
  return (
    <>
      <CuratedTemplateChoice
        apiClient={apiClient}
        userId={userId}
        disabled={locked}
        onChoose={onChooseTemplate}
      />
      <FieldGroup>
        <LabelledField
          id="portable-workflow-file"
          label="Workflow JSON file"
          error={validation.error('file')}
        >
          {(control) => (
            <Input
              key={fileGeneration}
              {...control}
              ref={validation.register('file')}
              name="workflow-file"
              type="file"
              autoComplete="off"
              accept=".json,application/json"
              disabled={locked}
              onChange={(event) => {
                onChooseFile(event.target.files?.[0]);
              }}
            />
          )}
        </LabelledField>
        <LabelledField
          id="portable-workflow-name"
          label="New workflow name"
          error={validation.error('name')}
        >
          {(control) => (
            <Input
              {...control}
              ref={validation.register('name')}
              name="workflow-name"
              value={name}
              maxLength={128}
              disabled={locked}
              autoComplete="off"
              onChange={(event) => {
                onNameChange(event.target.value);
                validation.change(
                  'name',
                  workflowNameError(event.target.value),
                );
              }}
            />
          )}
        </LabelledField>
      </FieldGroup>
      {template === undefined ? null : (
        <CuratedSetupFields
          targets={template.setupTargets}
          values={setupValues}
          locked={locked}
          validation={validation}
          onChange={onSetupChange}
        />
      )}
    </>
  );
}
