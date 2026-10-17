import { useId } from 'react';
import {
  workspaceNoticeKindSchema,
  type WorkspaceNoticeKind,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
const noticeKinds = [
  { value: 'all', label: 'All notice kinds' },
  { value: 'workflow_failure', label: 'Workflow failures' },
  { value: 'workflow_auto_paused', label: 'Auto-paused workflows' },
  { value: 'connection_attention', label: 'Connections needing attention' },
  { value: 'limit_reached', label: 'Limits reached' },
  { value: 'limit_approaching', label: 'Approaching limits' },
  { value: 'approval_waiting', label: 'Approvals waiting' },
];
export function NoticeKindFilter({
  kind,
  onChange,
}: {
  kind: WorkspaceNoticeKind | undefined;
  onChange: (kind: WorkspaceNoticeKind | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="max-w-xs">
      <LabelledField id={id} label="Notice kind">
        {(control) => (
          <Select
            items={noticeKinds}
            value={kind ?? 'all'}
            onValueChange={(value) => {
              if (value === 'all') onChange(undefined);
              else {
                const parsed = workspaceNoticeKindSchema.safeParse(value);
                if (parsed.success) onChange(parsed.data);
              }
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {noticeKinds.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </LabelledField>
    </div>
  );
}
