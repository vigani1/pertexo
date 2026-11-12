import type { WorkflowTestSuitePreparation } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { LabelledField } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
export function SuitePreparation({
  preparation,
  acknowledged,
  onAcknowledgedChange,
  locked,
}: Readonly<{
  preparation: WorkflowTestSuitePreparation;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  locked: boolean;
}>) {
  return (
    <div className="contents">
      <p className="text-sm">
        Draft {preparation.draftRevision} · {preparation.cases.length} cases ·{' '}
        {preparation.samples.length} pinned steps
      </p>
      {preparation.cases.length === 0 ? (
        <Notice>
          Create a saved input case first. A suite can contain up to 50 cases.
        </Notice>
      ) : (
        <ol className="list-inside list-decimal text-sm">
          {preparation.cases.map((item) => (
            <li key={item.id} className="wrap-anywhere">
              {item.name}
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted-foreground">
        Wait completes immediately. Approval, Request input and Call need a pin.
        Canceling stops the suite; it cannot undo effects already performed.
      </p>
      {preparation.effectfulSteps.length === 0 ? null : (
        <section aria-label="Suite effects" className="space-y-3">
          <p className="text-sm">
            These unpinned steps can change real data for every case:
          </p>
          <ul className="list-inside list-disc text-sm">
            {preparation.effectfulSteps.map((step) => (
              <li key={step.nodeId}>{step.label}</li>
            ))}
          </ul>
          <LabelledField
            id="suite-effects"
            label="I understand every case runs these steps for real"
          >
            {(control) => (
              <Switch
                {...control}
                disabled={locked}
                checked={acknowledged}
                onCheckedChange={onAcknowledgedChange}
              />
            )}
          </LabelledField>
        </section>
      )}
    </div>
  );
}
