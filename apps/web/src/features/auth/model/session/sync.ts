const CHANNEL_NAME = 'pertexo-auth-session';
const STORAGE_KEY = 'pertexo:auth-session-change';
const tabId = crypto.randomUUID();

/** `signed-out`: someone signed out on purpose, so every tab follows. */
export type SessionChangeEvent = 'changed' | 'signed-out';

type SessionChangeSignal = Readonly<{
  event: SessionChangeEvent;
  generation: string;
  sender: string;
}>;

function isSessionChangeSignal(value: unknown): value is SessionChangeSignal {
  if (typeof value !== 'object' || value === null) return false;
  const signal = value as Record<string, unknown>;
  return (
    (signal.event === 'changed' || signal.event === 'signed-out') &&
    typeof signal.generation === 'string' &&
    typeof signal.sender === 'string'
  );
}

/** A notification to revalidate, never an authentication authority. */
export function publishSessionChange(
  event: SessionChangeEvent = 'changed',
): void {
  const signal: SessionChangeSignal = {
    event,
    generation: crypto.randomUUID(),
    sender: tabId,
  };
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(signal);
      channel.close();
    } catch {
      // Storage still signals other tabs when the channel is unavailable.
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(signal));
  } catch {
    // BroadcastChannel still works when storage is unavailable.
  }
}

const observers = new Set<() => void>();
const appListeners = new Set<(event: SessionChangeEvent) => void>();
let disconnect: (() => void) | undefined;

/** Dispose local private payloads and pause effectful work without rechecking authority. */
export function observeSessionChanges(onChange: () => void): () => void {
  observers.add(onChange);
  return () => {
    observers.delete(onChange);
  };
}
export function notifySessionObservers() {
  for (const observer of observers) observer();
}

/**
 * This tab found an account it didn't expect, such as a command's identity
 * check failing: everything reacts as if another tab had changed the session.
 */
export function reportSessionChange() {
  notifySessionObservers();
  for (const listener of appListeners) listener('changed');
}

/** The application owns the browser connection; component owners observe the same signal. */
export function subscribeSessionChanges(
  onChange: (event: SessionChangeEvent) => void,
): () => void {
  appListeners.add(onChange);
  disconnect ??= connectSessionChanges((event) => {
    notifySessionObservers();
    for (const listener of appListeners) listener(event);
  });
  return () => {
    appListeners.delete(onChange);
    if (appListeners.size === 0) {
      disconnect?.();
      disconnect = undefined;
    }
  };
}

function connectSessionChanges(
  onChange: (event: SessionChangeEvent) => void,
): () => void {
  let lastGeneration: string | undefined;
  function receive(value: unknown) {
    if (!isSessionChangeSignal(value)) return;
    if (value.sender === tabId || value.generation === lastGeneration) return;
    lastGeneration = value.generation;
    onChange(value.event);
  }

  let channel: BroadcastChannel | undefined;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      // A storage event remains available in browsers that deny this channel.
    }
  }
  const onMessage = (event: MessageEvent<unknown>) => {
    receive(event.data);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    try {
      receive(JSON.parse(event.newValue) as unknown);
    } catch {
      // Ignore malformed signals; server state is always verified separately.
    }
  };
  channel?.addEventListener('message', onMessage);
  window.addEventListener('storage', onStorage);
  return () => {
    channel?.removeEventListener('message', onMessage);
    channel?.close();
    window.removeEventListener('storage', onStorage);
  };
}
