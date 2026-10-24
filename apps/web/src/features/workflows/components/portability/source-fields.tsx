import type { WorkflowPortableManifest } from '@pertexo/workflow-model';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../../model/rename';
import type { CuratedTemplate } from '../../model/templates/curated-setup';
import { CuratedTemplateChoice } from '../templates/curated-template-choice';
import { CuratedSetupFields } from '../templates/setup-fields';
import { WorkflowFileDrop } from './file-drop';

/** Editable source selection; reading, previewing and commands stay in the owner. */
export function WorkflowImportSourceFields({
  locked,
  validation,
  scope,
  source,
  fields,
}: Readonly<{
  locked: boolean;
  validation: ReturnType<typeof useFieldValidation<string>>;
  scope: Readonly<{ apiClient: ApiClient; userId: string }>;
  source: Readonly<{
    template: CuratedTemplate | undefined;
    manifest: WorkflowPortableManifest | undefined;
    optionalSlots: ReadonlySet<string>;
    fileGeneration: number;
    reading: boolean;
    /** The example the dialog opened on; without one it takes a file. */
    example: string | undefined;
    /** The example still to choose for the person, until they've chosen one. */
    opening: string | undefined;
    onChooseTemplate: (template: CuratedTemplate) => void;
    onChooseFile: (file: File | undefined) => void;
  }>;
  fields: Readonly<{
    setupValues: readonly string[];
    name: string;
    onNameChange: (name: string) => void;
    onSetupChange: (index: number, value: string) => void;
  }>;
}>) {
  const { apiClient, userId } = scope;

  const {
    template,
    manifest,
    optionalSlots,
    fileGeneration,
    reading,
    example,
    opening,
    onChooseTemplate,
    onChooseFile,
  } = source;

  const { setupValues, name, onNameChange, onSetupChange } = fields;

  return (
    <>
      {example === undefined ? (
        <WorkflowFileDrop
          key={fileGeneration}
          inputRef={validation.register('file')}
          error={validation.error('file')}
          locked={locked}
          reading={reading}
          manifest={manifest}
          optionalSlots={optionalSlots}
          onChoose={onChooseFile}
        />
      ) : (
        <CuratedTemplateChoice
          apiClient={apiClient}
          userId={userId}
          disabled={locked}
          selectedId={template?.templateId}
          initialId={opening}
          onChoose={onChooseTemplate}
        />
      )}
      <FieldGroup>
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
