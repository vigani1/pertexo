import type { UseQueryResult } from '@tanstack/react-query';
import type { StepSampleResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Notice } from '@/components/ui/notice';
import { JsonTree } from '@/components/patterns/json-tree';
import { formatByteLength } from '@/lib/format/bytes';
import type { SampleDialogSource } from '../../model/step-samples';
export function SampleContent({
  query,
  source,
  text,
  onTextChange,
  locked,
}: Readonly<{
  query: UseQueryResult<StepSampleResponse>;
  source: SampleDialogSource;
  text: string;
  onTextChange: (text: string) => void;
  locked: boolean;
}>) {
  if (query.isError)
    return (
      <Notice tone="destructive">
        The sample couldn’t be loaded.{' '}
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Try again
        </Button>
      </Notice>
    );
  if (query.data === undefined) return <p role="status">Loading sample…</p>;
  return (
    <>
      <SampleOutputEditor
        data={query.data}
        source={source}
        text={text}
        onTextChange={onTextChange}
        locked={locked}
      />
      {query.data.sample === null || source === 'view' ? null : (
        <p className="text-xs text-muted-foreground">
          This replaces the existing sample.
        </p>
      )}
    </>
  );
}
function SampleOutputEditor({
  data,
  source,
  text,
  onTextChange,
  locked,
}: Readonly<{
  data: StepSampleResponse;
  source: SampleDialogSource;
  text: string;
  onTextChange: (text: string) => void;
  locked: boolean;
}>) {
  if (source === 'paste')
    return (
      <Field>
        <FieldLabel htmlFor="pinned-sample-json">Output (JSON)</FieldLabel>
        <Textarea
          id="pinned-sample-json"
          className="min-h-48 font-mono"
          spellCheck={false}
          autoComplete="off"
          value={text}
          disabled={locked}
          onChange={(event) => {
            onTextChange(event.target.value);
          }}
        />
        <FieldDescription>
          Up to {formatByteLength(data.limits.inlineBytes)} of JSON. File
          references aren’t supported; use Read file to turn a file into JSON
          first.
        </FieldDescription>
      </Field>
    );
  if (source === 'view')
    return data.sample?.state === 'expired' ? (
      <Notice>This output expired. Pin fresh data to test this step.</Notice>
    ) : (
      <JsonTree label="Pinned output" value={data.output} />
    );
  return (
    <p className="text-sm text-muted-foreground">
      Copy this retained output into the draft. Replacing a pin erases its old
      output. The sample expires after 30 days.
    </p>
  );
}
