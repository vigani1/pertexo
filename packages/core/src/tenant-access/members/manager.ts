import { isAdministrativeRole, type Role } from '@pertexo/workflow-model';

/** An owner or admin whose membership and user are both active. */
export function isActiveMemberManager<
  Member extends Readonly<{ role: Role; status: string; user_status: string }>,
>(actor: Member | undefined): actor is Member {
  return (
    actor?.status === 'active' &&
    actor.user_status === 'active' &&
    isAdministrativeRole(actor.role)
  );
}
