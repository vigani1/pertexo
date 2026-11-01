import {
  workspaceNoticeKindSchema,
  type WorkspaceNoticeKind,
} from '@pertexo/contracts';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
const noticeKinds = [
  { value: 'all', label: 'All notices' },
  { value: 'workflow_failure', label: 'Workflow failures' },
  { value: 'workflow_auto_paused', label: 'Auto-paused workflows' },
  { value: 'connection_attention', label: 'Connections needing attention' },
  { value: 'failure_alert_attention', label: 'Failure alerts not delivered' },
  { value: 'limit_reached', label: 'Limits reached' },
  { value: 'limit_approaching', label: 'Approaching limits' },
  { value: 'approval_waiting', label: 'Approvals waiting' },
  { value: 'publication_review_waiting', label: 'Publication reviews' },
  { value: 'workflow_mention', label: 'Comment mentions' },
];
export function NoticeKindFilter({
  kind,
  onChange,
}: {
  kind: WorkspaceNoticeKind | undefined;
  onChange: (kind: WorkspaceNoticeKind | undefined) => void;
}) {
  return (
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
      <SelectTrigger
        aria-label="Show notices about"
        className="h-8 w-40 sm:w-52"
      >
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
  );
}
