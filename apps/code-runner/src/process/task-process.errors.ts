export class TaskReservationUsedError extends Error {
  public override readonly name = 'TaskReservationUsedError';
}

export class CodePackageError extends Error {
  public override readonly name = 'CodePackageError';
}

export class TaskProcessStartError extends Error {
  public override readonly name = 'TaskProcessStartError';
}

export class TaskProcessReusedError extends Error {
  public override readonly name = 'TaskProcessReusedError';
}

export class TaskCanceledError extends Error {
  public override readonly name = 'TaskCanceledError';
}
