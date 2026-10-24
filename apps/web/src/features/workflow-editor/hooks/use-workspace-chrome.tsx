import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  WorkflowTestButton,
  WorkflowTestMenuItems,
} from '@/features/workflow-publish/tests.public';
import type { ComponentProps } from 'react';
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
  const chrome: EditorChrome = {
    renderFeedback: (feedback) =>
      feedbackTarget === null ? null : createPortal(feedback, feedbackTarget),
    workflowTestAction: (
      <WorkflowTestButton tests={tests} className="hidden sm:inline-flex" />
    ),
    workflowTestMenuItems: <WorkflowTestMenuItems tests={tests} />,
    shortcutsOpen,
    onShortcutsOpenChange: setShortcutsOpen,
    issuesOpen,
    onIssuesOpenChange: setIssuesOpen,
    onFix: onFix,
  };
  return { chrome, setFeedbackTarget };
}
