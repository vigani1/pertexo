import { HTTP_MULTIPART_MAX_PARTS } from '@pertexo/integrations';
import { Button } from '@/components/ui/button';
import { formatByteLength } from '@/lib/format/bytes';

import {
  newFormPart,
  type FormPartDraft,
  type HttpBodyDraft,
  type BodyValidation,
} from '../../../model/inspector/http-body';
import { FormPart } from './part';
import { focusFormPart } from './focus';

export function MultipartParts({
  parts,
  validation,
  editable,
  change,
  onChangePart,
  onRemove,
  context,
  upload,
}: Readonly<{
  parts: readonly FormPartDraft[];
  validation: BodyValidation;
  editable: boolean;
  change: (next: HttpBodyDraft, key: string) => void;
  onChangePart: (part: FormPartDraft, field: string) => string | undefined;
  onRemove: (part: FormPartDraft) => void;
  context: Parameters<typeof FormPart>[0]['context'];
  upload: Parameters<typeof FormPart>[0]['upload'];
}>) {
  const { nodeId, graph, loopPorts } = context;

  const { scope, targetKey } = upload;

  return (
    <>
      <p className="text-sm text-muted-foreground">
        The whole request must fit in 10 MB, including form headers. A full 10
        MB file will not fit. Split larger files into separate uploads accepted
        by your destination.
      </p>
      <p className="text-xs text-subtle-foreground">
        {validation.value === undefined ? (
          'Finish the parts to see a size estimate.'
        ) : (
          <>
            Known data: {formatByteLength(validation.knownBytes)}, plus form
            headers
            {validation.unknownSize ? ' and mapped values' : ''}. Final size is
            checked when the step runs.
          </>
        )}
      </p>
      {validation.error !== undefined &&
      Object.keys(validation.parts).length === 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {validation.error}
        </p>
      ) : null}
      <div className="flex flex-col gap-4">
        {parts.map((part, index) => (
          <FormPart
            key={part.inputKey}
            part={part}

            editable={editable}
            errors={validation.parts[part.inputKey]}

            actions={{
              onChange: onChangePart,
              onMove: (direction) => {
                const next = [...parts];
                const target = index + direction;
                const moved = next[index];
                const other = next[target];
                if (moved === undefined || other === undefined) return;
                next[index] = other;
                next[target] = moved;
                change(
                  { mode: 'multipart', parts: next },
                  `move:${crypto.randomUUID()}`,
                );
                focusFormPart(nodeId, part.inputKey);
              },
              onRemove: () => {
                onRemove(part);
              },
            }}
            position={{ index: index, count: parts.length }}
            upload={{ scope: scope, targetKey: targetKey }}
            context={{ nodeId: nodeId, graph: graph, loopPorts: loopPorts }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {(['text', 'file'] as const).map((kind) => (
          <Button
            key={kind}
            id={`${nodeId}-add-${kind}-part`}
            type="button"
            variant="outline"
            size="sm"
            disabled={!editable || parts.length >= HTTP_MULTIPART_MAX_PARTS}
            onClick={() => {
              const added = newFormPart(kind);
              change(
                { mode: 'multipart', parts: [...parts, added] },
                `add:${crypto.randomUUID()}`,
              );
              focusFormPart(nodeId, added.inputKey);
            }}
          >
            {kind === 'text' ? 'Add text part' : 'Add file part'}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Up to {HTTP_MULTIPART_MAX_PARTS} ordered parts. Repeated field names
        keep their order. Switch to Raw body to clear the whole form. Pertexo
        generates Content-Type; remove any custom Content-Type from the step or
        connection.
      </p>
    </>
  );
}
