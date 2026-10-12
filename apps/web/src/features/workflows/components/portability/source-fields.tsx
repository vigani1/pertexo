import type { WorkflowPortableManifest } from '@pertexo/workflow-model';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { useFieldValidation } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { workflowNameError } from '../../model/rename';
import type { CuratedTemplate } from '../../model/templates/curated-setup';
import { CuratedTemplateChoice } from '../templates/curated-template-choice';
import { CuratedSetupFields } from '../templates/setup-fields';
import { WorkflowFileDrop } from './file-drop';

/** Editable source selection; reading, previewing and commands stay in the owner. */
export function WorkflowImportSourceFields({
  apiClient,
  userId,
  template,
  manifest,
  setupValues,
  name,
  fileGeneration,
  reading,
  locked,
  validation,
  examplesFirst,
  onChooseTemplate,
  onChooseFile,
  onNameChange,
  onSetupChange,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  template: CuratedTemplate | undefined;
  manifest: WorkflowPortableManifest | undefined;
  setupValues: readonly string[];
  name: string;
  fileGeneration: number;
  reading: boolean;
  locked: boolean;
  validation: ReturnType<typeof useFieldValidation<string>>;
  /** Opened to choose an example, so the examples start unfolded. */
  examplesFirst: boolean;
  onChooseTemplate: (template: CuratedTemplate) => void;
  onChooseFile: (file: File | undefined) => void;
  onNameChange: (name: string) => void;
  onSetupChange: (index: number, value: string) => void;
}>) {
  const [examplesOpen, setExamplesOpen] = useState(examplesFirst);
  const showExamples = examplesOpen || template !== undefined;
  return (
    <>
      <WorkflowFileDrop
        key={fileGeneration}
        inputRef={validation.register('file')}
        error={validation.error('file')}
        locked={locked}
        reading={reading}
        manifest={template === undefined ? manifest : undefined}
        onChoose={onChooseFile}
      />
      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={showExamples}
          aria-controls="import-examples"
          disabled={template !== undefined}
          onClick={() => {
            setExamplesOpen((open) => !open);
          }}
          className="flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:text-foreground"
        >
          Or start from a ready-made example
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              'size-4 transition-transform motion-reduce:transition-none',
              showExamples && 'rotate-180',
            )}
          />
        </button>
        {showExamples ? (
          <div id="import-examples">
            <CuratedTemplateChoice
              apiClient={apiClient}
              userId={userId}
              disabled={locked}
              selectedId={template?.templateId}
              onChoose={onChooseTemplate}
            />
          </div>
        ) : null}
      </div>
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
