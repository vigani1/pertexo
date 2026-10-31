import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export type MailboxBehavior = Readonly<{
  /**
   * Greets nobody until this many senders are connected at once. A sender does
   * nothing durable before the greeting, so they all get there with what they read
   * before connecting, and meet on purpose rather than by timing.
   */
  greetTogether?: number;
  /** Holds the answer to a message this long, as a slow server does. */
  answerAfterMs?: number;
}>;

export type Mailbox = Readonly<{
  close: () => Promise<void>;
  /** The most senders that were connected at the same moment. */
  mostConnectedAtOnce: () => number;
  /** One entry per message accepted, with its recipient. */
  messages: () => readonly string[];
  port: number;
}>;

/** The outside mail server: accepts plain SMTP on loopback and records what it took. */
export async function startMailbox(
  behavior: MailboxBehavior = {},
): Promise<Mailbox> {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const awaitingGreeting = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let mostConnected = 0;
  let greeted = behavior.greetTogether === undefined;

  const greet = (socket: Socket): void => {
    socket.write('220 mailbox ready\r\n');
  };

  const answerMessage = (socket: Socket): void => {
    const answer = (): void => {
      if (!socket.destroyed) socket.write('250 2.0.0 accepted\r\n');
    };
    if (behavior.answerAfterMs === undefined) {
      answer();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      answer();
    }, behavior.answerAfterMs);
    timers.add(timer);
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    mostConnected = Math.max(mostConnected, sockets.size);
    socket.on('close', () => {
      sockets.delete(socket);
      awaitingGreeting.delete(socket);
    });
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    if (greeted) greet(socket);
    else {
      awaitingGreeting.add(socket);
      if (awaitingGreeting.size >= (behavior.greetTogether ?? 0)) {
        greeted = true;
        for (const waiting of awaitingGreeting) greet(waiting);
        awaitingGreeting.clear();
      }
    }
    let recipient = '';
    let inData = false;
    let pending = '';
    socket.on('data', (chunk: string) => {
      pending += chunk;
      if (inData) {
        if (!/(?:^|\r\n)\.\r\n$/u.test(pending)) return;
        inData = false;
        pending = '';
        messages.push(recipient);
        answerMessage(socket);
        return;
      }
      const lines = pending.split('\r\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 mailbox\r\n');
        else if (verb === 'RCPT') {
          recipient = /<(?<address>[^>]+)>/u.exec(line)?.groups?.address ?? '';
          socket.write('250 2.1.5 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return Object.freeze({
    port,
    messages: () => [...messages],
    mostConnectedAtOnce: () => mostConnected,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  });
}
