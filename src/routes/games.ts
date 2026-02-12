import { FastifyInstance } from 'fastify';
import { authenticate } from '../plugins/auth';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { users, games, gameInvitations } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const INITIAL_BOARD = '---------';

export async function gamesRoutes(server: FastifyInstance) {
  server.addHook('onRequest', authenticate);

  // GET /games — listar juegos donde participo (iniciados / en curso / finalizados)
  server.get('/', async (request, reply) => {
    const userId = request.user.id;
    try {
      const gamesAsX = await db
        .select({
          id: games.id,
          status: games.status,
          playerTurn: games.playerTurn,
          createdAt: games.createdAt,
          opponentId: games.playerOId,
          opponentUsername: users.username,
        })
        .from(games)
        .innerJoin(users, eq(games.playerOId, users.id))
        .where(eq(games.playerXId, userId));

      const gamesAsO = await db
        .select({
          id: games.id,
          status: games.status,
          playerTurn: games.playerTurn,
          createdAt: games.createdAt,
          opponentId: games.playerXId,
          opponentUsername: users.username,
        })
        .from(games)
        .innerJoin(users, eq(games.playerXId, users.id))
        .where(eq(games.playerOId, userId));

      const list = [
        ...gamesAsX.map((g) => ({ ...g, mySymbol: 'X' as const })),
        ...gamesAsO.map((g) => ({ ...g, mySymbol: 'O' as const })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return reply.status(200).send({ success: true, games: list });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al obtener juegos' });
    }
  });

  // GET /games/invitations — solicitudes de juego recibidas (PENDING)
  server.get('/invitations', async (request, reply) => {
    const userId = request.user.id;
    try {
      const list = await db
        .select({
          invitationId: gameInvitations.id,
          senderId: gameInvitations.senderId,
          senderName: users.username,
          createdAt: gameInvitations.createdAt,
        })
        .from(gameInvitations)
        .innerJoin(users, eq(gameInvitations.senderId, users.id))
        .where(
          and(
            eq(gameInvitations.receiverId, userId),
            eq(gameInvitations.status, 'PENDING')
          )
        )
        .orderBy(desc(gameInvitations.createdAt));

      return reply.status(200).send({ success: true, invitations: list });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al obtener invitaciones' });
    }
  });

  // POST /games/invite — enviar solicitud de juego { targetUsername: string }
  server.post('/invite', async (request, reply) => {
    const { targetUsername } = request.body as { targetUsername: string };
    const senderId = request.user.id;

    if (!targetUsername?.trim()) {
      return reply.status(400).send({ success: false, error: 'Falta targetUsername' });
    }

    try {
      const targetUsers = await db.select().from(users).where(eq(users.username, targetUsername.trim()));
      const targetUser = targetUsers[0];
      if (!targetUser) {
        return reply.status(404).send({ success: false, error: 'Usuario no encontrado' });
      }
      if (targetUser.id === senderId) {
        return reply.status(400).send({ success: false, error: 'No puedes invitarte a ti mismo' });
      }

      const existing = await db
        .select()
        .from(gameInvitations)
        .where(
          and(
            eq(gameInvitations.senderId, senderId),
            eq(gameInvitations.receiverId, targetUser.id),
            eq(gameInvitations.status, 'PENDING')
          )
        );
      if (existing.length > 0) {
        return reply.status(400).send({ success: false, error: 'Ya hay una invitación pendiente' });
      }

      await db.insert(gameInvitations).values({
        senderId,
        receiverId: targetUser.id,
        status: 'PENDING',
      });

      return reply.status(200).send({ success: true, message: 'Invitación enviada' });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al enviar invitación' });
    }
  });

  // POST /games/invitations/:id/accept — aceptar invitación (crea partida)
  server.post('/invitations/:id/accept', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const userId = request.user.id;

    if (!Number.isInteger(id) || id < 1) {
      return reply.status(400).send({ success: false, error: 'Id inválido' });
    }

    try {
      const invs = await db
        .select()
        .from(gameInvitations)
        .where(
          and(
            eq(gameInvitations.id, id),
            eq(gameInvitations.receiverId, userId),
            eq(gameInvitations.status, 'PENDING')
          )
        );
      const inv = invs[0];
      if (!inv) {
        return reply.status(404).send({ success: false, error: 'Invitación no encontrada o ya usada' });
      }

      await db
        .update(gameInvitations)
        .set({ status: 'ACCEPTED' })
        .where(eq(gameInvitations.id, id));

      await db.insert(games).values({
        playerXId: inv.senderId,
        playerOId: inv.receiverId,
        boardState: INITIAL_BOARD,
        playerTurn: 'X',
        status: 'ACTIVE',
      });

      return reply.status(200).send({ success: true, message: 'Partida creada' });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al aceptar invitación' });
    }
  });

  // POST /games/invitations/:id/reject — rechazar invitación
  server.post('/invitations/:id/reject', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const userId = request.user.id;

    if (!Number.isInteger(id) || id < 1) {
      return reply.status(400).send({ success: false, error: 'Id inválido' });
    }

    try {
      const result = await db
        .update(gameInvitations)
        .set({ status: 'REJECTED' })
        .where(
          and(
            eq(gameInvitations.id, id),
            eq(gameInvitations.receiverId, userId),
            eq(gameInvitations.status, 'PENDING')
          )
        )
        .returning();

      if (result.length === 0) {
        return reply.status(404).send({ success: false, error: 'Invitación no encontrada' });
      }
      return reply.status(200).send({ success: true, message: 'Invitación rechazada' });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al rechazar' });
    }
  });
}
