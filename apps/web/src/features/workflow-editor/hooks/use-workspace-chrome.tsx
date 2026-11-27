import { useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { WorkflowTestButton } from '@/features/workflow-testing/workflow-testing-views.public';
import type { EditorChrome } from '../components/editor-workspace';

export function useWorkspaceChrome({
  tests,
  onFix,
}: Readonly<{
  tests: ComponentProps<typeof WorkflowTestButton>['tests'];
  onFix: EditorChrome['onFix'];
}>) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [feedbackTarget, setFeedbackTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const overflowRef = useRef<HTMLButtonElement>(null);
  const chrome: Omit<EditorChrome, 'openProposal'> = {
    overflowRef,
    renderFeedback: (feedback) =>
      feedbackTarget === null ? null : createPortal(feedback, feedbackTarget),
    renderTestAction: (runItems) => (
      <WorkflowTestButton tests={tests} runItems={runItems} />
    ),
    shortcutsOpen,
    onShortcutsOpenChange: setShortcutsOpen,
    issuesOpen,
    onIssuesOpenChange: setIssuesOpen,
    onFix: onFix,
  };
  return { chrome, setFeedbackTarget };
}
