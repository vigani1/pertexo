import type { WorkflowPromotionMode } from '@pertexo/contracts';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
const modeNames: Readonly<Record<WorkflowPromotionMode, string>> = {
  draft: 'Create drafts',
  publish: 'Publish',
  request_approval: 'Request approval',
};

export function PromotionActionFields({
  mode,
  note,
  disabled,
  requireApproval,
  onMode,
  onNote,
}: {
  mode: WorkflowPromotionMode;
  note: string;
  disabled: boolean;
  requireApproval: boolean;
  onMode: (mode: WorkflowPromotionMode) => void;
  onNote: (note: string) => void;
}) {
  return (
    <>
      <label className="grid max-w-md gap-2 text-sm">
        Target action
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(value) => {
            if (value !== null) onMode(value);
          }}
        >
          <SelectTrigger>
            <SelectValue>{modeNames[mode]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Create drafts</SelectItem>
            {requireApproval ? (
              <SelectItem value="request_approval">Request approval</SelectItem>
            ) : (
              <SelectItem value="publish">Publish</SelectItem>
            )}
          </SelectContent>
        </Select>
      </label>
      {mode === 'publish' ? (
        <Notice tone="warning">
          Publishing makes these versions live and can activate their schedules.
          Target webhook secrets and public form access are kept; new form
          triggers start as members-only.
        </Notice>
      ) : null}
      {mode === 'request_approval' ? (
        <label className="grid gap-2 text-sm">
          Review note
          <Textarea
            value={note}
            maxLength={1000}
            disabled={disabled}
            onChange={(event) => {
              onNote(event.target.value);
            }}
          />
          <span className="text-xs text-muted-foreground">
            An owner or admin in the target workspace must review the promoted
            draft. You cannot approve your own request.
          </span>
        </label>
      ) : null}
    </>
  );
}
