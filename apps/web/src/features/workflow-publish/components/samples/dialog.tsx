import { DialogFooter } from '@/components/ui/dialog';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { stepSampleSourceSchema } from '@pertexo/contracts';
import type { SampleDialogSource } from '../../model/testing/samples';
import { SampleContent } from './content';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { SampleScope } from '../../data/samples/api';
import { stepSampleQueryOptions } from '../../data/samples/queries';
import { useSampleCommand } from './use-command';
export function PinSampleDialog({
  scope,
  nodeId,
  source,
  ensureSaved,
  onClose,
}: Readonly<{
  scope: SampleScope;
  nodeId: string;
  source: SampleDialogSource;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  onClose: () => void;
}>) {
  const query = useQuery(stepSampleQueryOptions(scope, nodeId));
  const [text, setText] = useState('{}');
  const [parseError, setParseError] = useState<string>();
  const command = useSampleCommand(scope, nodeId, ensureSaved, onClose);
  const locked = command.pending || command.uncertain;
  async function save() {
    if (query.isError || query.data === undefined || source === 'view') return;
    setParseError(undefined);
    if (source !== 'paste') {
      await command.save(source, query.data.sample);
      return;
    }
    try {
      const value: unknown = JSON.parse(text);
      await command.save(
        stepSampleSourceSchema.parse({ kind: 'json', value }),
        query.data.sample,
      );
    } catch {
      setParseError(
        'Enter valid JSON within the size and depth limits, like {"amount": 1240}.',
      );
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && (!locked || command.expired)) onClose();
      }}
    >
      <DialogContent className="flex flex-col gap-4">
        <div>
          <DialogTitle>
            {source === 'view' ? 'Pinned output' : 'Pin sample output'}
          </DialogTitle>
          <DialogDescription>
            Shared with people who can see run data. Editor tests use this
            output without calling the step. Published runs always run for real.
          </DialogDescription>
        </div>
        <SampleContent
          query={query}
          source={source}
          text={text}
          onTextChange={setText}
          locked={locked}
        />
        {parseError === undefined && command.error === undefined ? null : (
          <Notice tone="destructive">{parseError ?? command.error}</Notice>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={locked && !command.expired}
            onClick={onClose}
          >
            Close
          </Button>
          {command.uncertain ? (
            <Button
              disabled={command.pending || command.expired}
              onClick={command.retry}
            >
              Retry the same pin
            </Button>
          ) : null}
          {!command.uncertain && source !== 'view' ? (
            <ProgressButton
              pending={command.pending}
              pendingLabel="Pinning…"
              disabled={query.isError || query.data === undefined}
              onClick={() => void save()}
            >
              Pin output
            </ProgressButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
