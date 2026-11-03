/** What changed about a user's sign-in methods, email or profile. */
export type IdentitySecurityEvent =
  | 'email.initial_verified'
  | 'email.old_confirmed'
  | 'email.change_verified'
  | 'method.linked'
  | 'method.unlinked'
  | 'password.changed'
  | 'password.configured'
  | 'password.reset'
  | 'profile.display_name_changed'
  | 'session.signed_in'
  | 'two_factor.disabled'
  | 'two_factor.recovery_code_used'
  | 'two_factor.operator_disabled';
