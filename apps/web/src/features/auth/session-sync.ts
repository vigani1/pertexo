const CHANNEL_NAME = 'pertexo-auth-session-v1';
const STORAGE_KEY = 'pertexo:auth-session-change:v1';
const tabId = crypto.randomUUID();

type SessionChangeSignal = Readonly<{
  event: 'changed';
  generation: string;
  sender: string;
}>;

function isSessionChangeSignal(value: unknown): value is SessionChangeSignal {
  if (typeof value !== 'object' || value === null) return false;
  const signal = value as Record<string, unknown>;
  return (
    signal.event === 'changed' &&
    typeof signal.generation === 'string' &&
    typeof signal.sender === 'string'
  );
}

/** A notification to revalidate, never an authentication authority. */
export function publishSessionChange(): void {
  const signal: SessionChangeSignal = {
    event: 'changed',
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

export function subscribeSessionChanges(onChange: () => void): () => void {
  let lastGeneration: string | undefined;
  function receive(value: unknown) {
    if (!isSessionChangeSignal(value)) return;
    if (value.sender === tabId || value.generation === lastGeneration) return;
    lastGeneration = value.generation;
    onChange();
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
