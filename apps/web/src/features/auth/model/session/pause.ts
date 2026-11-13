/**
 * Why the page is paused. `expired`: the server said the session ended.
 * `checking`: another tab changed the session, and this tab is asking who is
 * signed in now. `unreachable`: that question got no answer.
 */
export type SessionPauseReason = 'expired' | 'checking' | 'unreachable';

export type SessionPauseState =
  | Readonly<{ kind: 'running'; generation: number }>
  | Readonly<{
      kind: 'paused';
      generation: number;
      /** The account the paused page belongs to. */
      userId: string;
      reason: SessionPauseReason;
    }>;

/**
 * One app's session pause. A page outside the workflow editor stays mounted,
 * hidden behind "Sign in again", while its session is unknown, so unsaved
 * input lives on in its components. `generation` changes when the page is
 * discarded, so its owner remounts it from scratch.
 */
export type SessionPause = Readonly<{
  current: () => SessionPauseState;
  subscribe: (listener: () => void) => () => void;
  pause: (userId: string, reason: SessionPauseReason) => void;
  resume: () => void;
  /** Ends the pause and remounts the page: its input belonged to someone else. */
  discard: () => void;
}>;

export function createSessionPause(): SessionPause {
  let state: SessionPauseState = { kind: 'running', generation: 0 };
  const listeners = new Set<() => void>();
  const set = (next: SessionPauseState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    current: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pause: (userId, reason) => {
      // A pause belongs to the account that owned the page when it began.
      const owner = state.kind === 'paused' ? state.userId : userId;
      if (state.kind === 'paused' && state.reason === reason) return;
      set({
        kind: 'paused',
        generation: state.generation,
        userId: owner,
        reason,
      });
    },
    resume: () => {
      if (state.kind === 'running') return;
      set({ kind: 'running', generation: state.generation });
    },
    discard: () => {
      set({ kind: 'running', generation: state.generation + 1 });
    },
  };
}
