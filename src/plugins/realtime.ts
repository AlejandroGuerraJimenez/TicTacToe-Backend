import { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { authenticate } from './auth';

// Tipos para uso interno: el servidor tiene JWT y el request autenticado tiene user
type ServerWithJwt = FastifyInstance & {
  jwt: { sign: (payload: object, opts?: { expiresIn?: string }) => string; verify: (token: string) => Promise<Record<string, unknown>> };
};
type AuthenticatedRequest = FastifyRequest & { user: { id: number; username: string; email: string } };

type SocketLike = { send: (data: string) => void; readyState: number };
const userSockets = new Map<number, Set<SocketLike>>();

export type RealtimePayload =
  | { event: 'friend_request'; data: { senderId: number; senderName: string } }
  | { event: 'friend_accepted'; data: { userId: number; username: string } }
  | { event: 'friend_rejected'; data: { userId: number; username: string } }
  | { event: 'friend_removed'; data: { userId: number } }
  | { event: 'game_move'; data: { gameId: number; opponentUsername: string } };

/** Envía a todas las conexiones activas de un usuario (varias pestañas/conexiones). */
export function notifyUser(userId: number, event: string, data: unknown): void {
  const set = userSockets.get(userId);
  if (!set || set.size === 0) {
    console.log('[Realtime] No enviado: userId=%s sin sockets (conectados: %s)', userId, Array.from(userSockets.keys()).join(','));
    return;
  }
  const payload = JSON.stringify({ event, data });
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(payload);
      sent++;
    }
  }
  console.log('[Realtime] Enviado a userId=%s evento=%s (%s conexiones)', userId, event, sent);
}

export function getConnectedUserIds(): number[] {
  return Array.from(userSockets.keys());
}

declare module 'fastify' {
  interface FastifyInstance {
    notifyUser: (userId: number, event: string, data: unknown) => void;
  }
}

export async function realtimePlugin(server: FastifyInstance) {
  await server.register(websocket);

  const app = server as ServerWithJwt;

  // Token corto para conectar el WebSocket (el navegador no envía cookies en WS)
  server.get('/ws-token', { onRequest: [authenticate] }, async (request, reply) => {
    const req = request as AuthenticatedRequest;
    const token = app.jwt.sign(
      { id: req.user.id, username: req.user.username, email: req.user.email },
      { expiresIn: '2m' }
    );
    return reply.send({ token });
  });

  server.get('/ws', { websocket: true }, (socket, req: { url?: string; raw?: { url?: string } }) => {
    const rawUrl = (req as { raw?: { url?: string } }).raw?.url ?? (req as { url?: string }).url ?? '/';
    const token = new URL(rawUrl, 'http://localhost').searchParams.get('token');
    if (!token) {
      server.log.warn('WebSocket conectado sin token, cerrando');
      socket.close();
      return;
    }
    (async () => {
      try {
        const decoded = await app.jwt.verify(token);
        if (!decoded || typeof decoded !== 'object' || !('id' in decoded)) {
          socket.close();
          return;
        }
        const userId = Number((decoded as { id: number }).id);
        let set = userSockets.get(userId);
        if (!set) {
          set = new Set();
          userSockets.set(userId, set);
        }
        set.add(socket);
        server.log.info({ userId, totalConnections: set.size }, 'WebSocket conectado');
        const remove = () => {
          if (!set.has(socket)) return;
          set.delete(socket);
          if (set.size === 0) userSockets.delete(userId);
          server.log.info({ userId }, 'WebSocket desconectado');
        };
        socket.on('close', remove);
        socket.on('error', remove);
      } catch {
        socket.close();
      }
    })();
  });

  server.decorate('notifyUser', notifyUser);
}
