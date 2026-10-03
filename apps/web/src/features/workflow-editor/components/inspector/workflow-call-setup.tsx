import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { readCallPinText } from '../../model/inspector/workflow-call-pin';
import type { NodeConfig } from '../../model/inspector/inspector-draft';
import type { NodeFormApi } from '../../model/inspector/node-form';
import { ConfigJsonEditor } from './config-json-editor';
import { WorkflowCallPinEditor } from './workflow-call-pin-editor';

/** One visible setup editor owns scratch; mode changes cannot discard it. */
export function WorkflowCallSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const supported = readCallPinText(config) !== undefined;
  const [jsonMode, setJsonMode] = useState(() => !supported);
  const [hasScratch, setHasScratch] = useState(false);
  const scopedForm = useMemo<NodeFormApi>(
    () => ({
      ...form,
      reportScratch: (field, scratch) => {
        setHasScratch(scratch);
        form.reportScratch(field, scratch);
      },
    }),
    [form],
  );
  const showJson = jsonMode || !supported;
  return (
    <FieldGroup className="gap-4">
      {showJson ? (
        <ConfigJsonEditor
          config={config}
          form={scopedForm}
          description="The exact Call configuration is preserved, including unknown properties. Typed pin fields are available only for the supported string fields. Saving does not verify target agreement or enable execution."
        />
      ) : (
        <WorkflowCallPinEditor config={config} form={scopedForm} />
      )}
      {supported ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          disabled={hasScratch}
          onClick={() => {
            setJsonMode((current) => !current);
          }}
        >
          {showJson ? 'Back to fields' : 'Edit as JSON'}
        </Button>
      ) : null}
    </FieldGroup>
  );
}
