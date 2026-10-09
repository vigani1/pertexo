import { useCallback, useState } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { ApiClient } from '@/lib/api/client';
import { InputCasesPanel, type LoadedInputCase } from './input-cases-panel';

export function InputCasesAction({
  apiClient,
  userId,
  workspace,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
}>) {
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [loaded, setLoaded] = useState<LoadedInputCase>();
  const clearLoaded = useCallback(() => {
    setLoaded(undefined);
  }, []);
  if (!workspace.capabilities.includes('workflow:read')) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !locked) {
          setOpen(next);
          if (!next) setLoaded(undefined);
        }
      }}
    >
      <DialogTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
      >
        Input cases
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Input cases</DialogTitle>
        <DialogDescription>
          Browse shared run inputs. Nothing here starts or tests a workflow.
        </DialogDescription>
        {open ? (
          <div className="mt-5 flex flex-col gap-5">
            <InputCasesPanel
              key={`${userId}:${workspace.id}:${workflow.id}`}
              apiClient={apiClient}
              userId={userId}
              workspace={workspace}
              workflow={workflow}
              onLockedChange={setLocked}
              onAccessLost={clearLoaded}
              onLoad={setLoaded}
            />
            {loaded === undefined ? null : (
              <FieldGroup>
                <LabelledField
                  id="loaded-case-copy"
                  label={`Loaded input: ${loaded.name}`}
                  description="Detached copy. Later saved-case changes do not rewrite it. To execute, open Run with input and load the case there."
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                      className="min-h-32 font-mono"
                      value={JSON.stringify(loaded.input, null, 2)}
                    />
                  )}
                </LabelledField>
              </FieldGroup>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                setOpen(false);
                setLoaded(undefined);
              }}
            >
              Close input cases
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
