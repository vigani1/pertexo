import { ArrowDownIcon, ArrowUpIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import { UploadFile, type FileUploadScope } from '@/features/artifacts/public';
import type {
  FormPartDraft,
  PartErrors,
} from '../../../model/inspector/http-body';

import { directPredecessorOptions } from '../../../model/inspector/input-mappings/draft';
import { ChoiceSelect } from '../fields/choice-select';
import {
  MappingValueEditor,
  type MappingSources,
} from '../input-mappings/value-editor';
import { FILE_LIMIT_COPY } from '../../../model/inspector/file-limit-copy';

export function FormPart({
  part,
  editable,
  errors,
  context,
  upload,
  position,
  actions,
}: Readonly<{
  part: FormPartDraft;
  editable: boolean;
  errors: PartErrors | undefined;
  context: Omit<MappingSources, 'predecessors'>;
  upload: Readonly<{
    scope: FileUploadScope | undefined;
    targetKey: string;
  }>;
  position: Readonly<{
    index: number;
    count: number;
  }>;
  actions: Readonly<{
    onChange: (part: FormPartDraft, field: string) => string | undefined;
    onMove: (direction: -1 | 1) => void;
    onRemove: () => void;
  }>;
}>) {
  const { graph, nodeId, loopPorts } = context;

  const { scope, targetKey } = upload;

  const { index, count } = position;

  const { onChange, onMove, onRemove } = actions;

  const prefix = `${nodeId}-${part.inputKey}`;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border border-surface-ink/10 bg-recess-ink/15 p-3">
      <legend className="max-w-full break-all px-1 text-xs text-muted-foreground">
        Part {index + 1}: {part.name === '' ? 'new part' : part.name}
      </legend>
      <PartActions
        index={index}
        count={count}
        editable={editable}
        onMove={onMove}
        onRemove={onRemove}
      />
      <LabelledField
        id={`${prefix}-name`}
        label="Field name"
        error={errors?.name}
      >
        {(control) => (
          <Input
            {...control}
            value={part.name}
            maxLength={128}
            disabled={!editable}
            onChange={(event) => {
              onChange({ ...part, name: event.currentTarget.value }, 'name');
            }}
          />
        )}
      </LabelledField>
      <LabelledField id={`${prefix}-kind`} label="Part value">
        {(control) => (
          <ChoiceSelect
            control={control}
            value={part.kind}
            disabled={!editable}
            choices={[
              { value: 'text', label: 'Text' },
              { value: 'file', label: 'File' },
            ]}
            onChange={(kind) => {
              if (kind === 'text' || kind === 'file')
                onChange(
                  {
                    ...part,
                    kind,
                    source: {
                      id: part.inputKey,
                      destinationKey: part.inputKey,
                      kind: 'literal',
                      literalJson: kind === 'text' ? '""' : 'null',
                    },
                  },
                  'kind',
                );
            }}
          />
        )}
      </LabelledField>
      <MappingValueEditor
        row={part.source}

        type={part.kind === 'text' ? 'string' : 'object'}
        error={errors?.source}
        disabled={!editable}
        onChange={(source) => {
          onChange({ ...part, source }, 'source');
        }}
        context={{
          nodeId: nodeId,
          graph: graph,
          predecessors: directPredecessorOptions(graph, nodeId),
          loopPorts: loopPorts,
        }}
      />
      {part.kind === 'file' && scope !== undefined ? (
        <UploadFile
          scope={scope}
          targetKey={`${part.inputKey}:${targetKey}`}
          disabled={!editable}
          label="Upload part file"
          useLabel="Use file for this part"
          description={`The entire request must fit in ${FILE_LIMIT_COPY.request} including form headers. A full ${FILE_LIMIT_COPY.request} file will not fit. Using a file replaces this part’s value; its original local filename is not saved.`}
          onUse={(reference) => {
            return onChange(
              {
                ...part,
                source: {
                  id: part.inputKey,
                  destinationKey: part.inputKey,
                  kind: 'literal',
                  literalJson: JSON.stringify(reference),
                },
              },
              'upload',
            );
          }}
        />
      ) : null}
      <PartMetadata
        prefix={prefix}
        part={part}
        editable={editable}
        errors={errors}
        onChange={onChange}
      />
    </fieldset>
  );
}

function PartActions({
  index,
  count,
  editable,
  onMove,
  onRemove,
}: Readonly<{
  index: number;
  count: number;
  editable: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}>) {
  return (
    <div className="flex justify-end gap-1">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!editable || index === 0}
        aria-label="Move part up"
        onClick={() => {
          onMove(-1);
        }}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!editable || index === count - 1}
        aria-label="Move part down"
        onClick={() => {
          onMove(1);
        }}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!editable || count === 1}
        aria-label="Remove part"
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function PartMetadata({
  prefix,
  part,
  editable,
  errors,
  onChange,
}: Readonly<{
  prefix: string;
  part: FormPartDraft;
  editable: boolean;
  errors: PartErrors | undefined;
  onChange: (part: FormPartDraft, field: string) => string | undefined;
}>) {
  return (
    <>
      {' '}
      <LabelledField
        id={`${prefix}-filename`}
        label="Filename (optional)"
        error={errors?.filename}
      >
        {(control) => (
          <Input
            {...control}
            value={part.filename}
            placeholder={part.kind === 'file' ? 'file' : 'No filename'}
            maxLength={255}
            disabled={!editable}
            onChange={(event) => {
              onChange(
                { ...part, filename: event.currentTarget.value },
                'filename',
              );
            }}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${prefix}-content-type`}
        label="Content type (optional)"
        error={errors?.contentType}
      >
        {(control) => (
          <Input
            {...control}
            value={part.contentType}
            placeholder={
              part.kind === 'text'
                ? 'text/plain; charset=utf-8'
                : 'Use the file’s media type'
            }
            maxLength={255}
            disabled={!editable}
            onChange={(event) => {
              onChange(
                { ...part, contentType: event.currentTarget.value },
                'content-type',
              );
            }}
          />
        )}
      </LabelledField>
    </>
  );
}
