import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export type Mailbox = Readonly<{
  close: () => Promise<void>;
  /** One entry per message accepted, with its recipient. */
  messages: () => readonly string[];
  port: number;
}>;

/** The outside mail server: accepts plain SMTP on loopback and records what it took. */
export async function startMailbox(): Promise<Mailbox> {
  const messages: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    socket.write('220 mailbox ready\r\n');
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
        socket.write('250 2.0.0 accepted\r\n');
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
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  });
}
