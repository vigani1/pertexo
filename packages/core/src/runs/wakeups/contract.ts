export interface DeadlineWakeupScanner {
  claimDueWakeups(limit: number, signal?: AbortSignal): Promise<number>;
  close(): Promise<void>;
}

export interface DueNodeWakeupScanner {
  claimDueWakeups(limit: number, signal?: AbortSignal): Promise<number>;
  close(): Promise<void>;
}
