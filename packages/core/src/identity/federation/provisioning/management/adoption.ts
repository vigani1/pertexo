import type { Role } from '@pertexo/workflow-model';

type AdoptionCandidate = Readonly<{
  role: Role;
  status: string;
  managed: boolean;
}>;

/** Whether a membership can be adopted, with the refusal in words the owner reads. */
export function judgeAdoption<Member extends AdoptionCandidate>(
  member: Member | undefined,
):
  | Readonly<{ eligible: true; member: Member }>
  | Readonly<{ eligible: false; reason: string }> {
  if (member?.role === 'owner')
    return {
      eligible: false,
      reason: 'Keep the recovery owner outside directory management.',
    };
  if (member?.status !== 'active')
    return {
      eligible: false,
      reason:
        'Only an active manual membership can be adopted. Reactivate an existing suspended or removed membership first.',
    };
  if (member.managed)
    return {
      eligible: false,
      reason: 'This membership is already directory-managed.',
    };
  return { eligible: true, member };
}
