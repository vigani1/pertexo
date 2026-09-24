import { Activity, Cable, UsersRound, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';

const workspaceContents = [
  { label: 'Workflows', icon: Workflow },
  { label: 'Connections', icon: Cable },
  { label: 'Run history', icon: Activity },
  { label: 'Team access', icon: UsersRound },
] as const;

export function WorkspaceOnboarding({
  onCreate,
}: Readonly<{ onCreate: () => void }>) {
  return (
    <section
      className="workspace-onboarding"
      aria-labelledby="workspace-onboarding-title"
    >
      <div className="workspace-onboarding-copy">
        <h1
          id="workspace-onboarding-title"
          className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
        >
          Create your workspace
        </h1>
        <p className="workspace-onboarding-description">
          This is where your team builds workflows, connects services, and
          follows every run from one operational home.
        </p>
        <Button type="button" variant="solid" size="lg" onClick={onCreate}>
          Create your first workspace
        </Button>
        <p className="workspace-invitation-note">
          Joining an existing team? Open the invitation link they sent you.
        </p>
      </div>

      <figure className="workspace-boundary">
        <figcaption>Your workspace keeps these parts together</figcaption>
        <div className="workspace-boundary-flow">
          {workspaceContents.map(({ label, icon: Icon }, index) => (
            <div className="workspace-boundary-step" key={label}>
              <span className="workspace-boundary-icon">
                <Icon aria-hidden="true" />
              </span>
              <span>{label}</span>
              {index === workspaceContents.length - 1 ? null : (
                <span className="workspace-boundary-connector" aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </figure>
    </section>
  );
}
