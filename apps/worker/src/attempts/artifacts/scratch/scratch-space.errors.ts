export class ScratchSpaceError extends Error {
  public override readonly name = 'ScratchSpaceError';
}

export class ScratchReservationError extends TypeError {
  public override readonly name = 'ScratchReservationError';
}
