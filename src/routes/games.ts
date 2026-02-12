import { FastifyInstance } from 'fastify';
import { authenticate } from '../plugins/auth';
import { notifyUser } from '../plugins/realtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { users, games, gameInvitations, chats, messages, friendships } from '../db/schema';
import { eq, and, desc, or } from 'drizzle-orm';

async function deleteGameChat(
  chatId: number | null,
  gameId: number
): Promise<void> {
  if (chatId == null) return;
  await db.update(games).set({ chatId: null }).where(eq(games.id, gameId));
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
}
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const INITIAL_BOARD = '---------';

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function checkWinner(board: string, symbol: string): boolean {
  return LINES.some(([a, b, c]) => board[a] === symbol && board[b] === symbol && board[c] === symbol);
}

function isDraw(board: string): boolean {
  return !board.includes('-');
}

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
          winnerId: games.winnerId,
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
          winnerId: games.winnerId,
          createdAt: games.createdAt,
          opponentId: games.playerXId,
          opponentUsername: users.username,
        })
        .from(games)
        .innerJoin(users, eq(games.playerXId, users.id))
        .where(eq(games.playerOId, userId));

      const list = [
        ...gamesAsX.map((g) => ({ ...g, mySymbol: 'X' as const, youWon: g.status === 'FINISHED' && g.winnerId === userId })),
        ...gamesAsO.map((g) => ({ ...g, mySymbol: 'O' as const, youWon: g.status === 'FINISHED' && g.winnerId === userId })),
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

      const friendRows = await db
        .select()
        .from(friendships)
        .where(
          or(
            and(eq(friendships.userId, senderId), eq(friendships.friendId, targetUser.id)),
            and(eq(friendships.userId, targetUser.id), eq(friendships.friendId, senderId))
          )
        );
      if (friendRows.length === 0) {
        return reply.status(403).send({
          success: false,
          error: 'Solo puedes invitar a jugar a tus amigos',
          code: 'NOT_FRIEND',
        });
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

      notifyUser(targetUser.id, 'game_invitation', {
        senderId,
        senderName: request.user.username,
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

      const [newChat] = await db.insert(chats).values({
        user1Id: inv.senderId,
        user2Id: inv.receiverId,
      }).returning({ id: chats.id });

      const [newGame] = await db.insert(games).values({
        playerXId: inv.senderId,
        playerOId: inv.receiverId,
        boardState: INITIAL_BOARD,
        playerTurn: 'X',
        status: 'ACTIVE',
        chatId: newChat.id,
        winnerId: null,
      }).returning({ id: games.id });

      await db.delete(gameInvitations).where(eq(gameInvitations.id, id));

      notifyUser(inv.senderId, 'game_invitation_accepted', {
        gameId: newGame.id,
        opponentUsername: request.user.username,
      });

      return reply.status(200).send({ success: true, message: 'Partida creada' });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al aceptar invitación' });
    }
  });

  // POST /games/invitations/:id/reject — rechazar invitación (se borra de la BD)
  server.post('/invitations/:id/reject', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const userId = request.user.id;

    if (!Number.isInteger(id) || id < 1) {
      return reply.status(400).send({ success: false, error: 'Id inválido' });
    }

    try {
      const result = await db
        .delete(gameInvitations)
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

  // GET /games/:id/chat — obtener o crear chat de la partida y mensajes (solo partidas en curso)
  server.get('/:id/chat', async (request, reply) => {
    const gameId = Number((request.params as { id: string }).id);
    const userId = request.user.id;
    if (!Number.isInteger(gameId) || gameId < 1) {
      return reply.status(400).send({ success: false, error: 'Id inválido' });
    }
    try {
      const rows = await db.select().from(games).where(eq(games.id, gameId));
      const game = rows[0];
      if (!game) return reply.status(404).send({ success: false, error: 'Partida no encontrada' });
      if (game.playerXId !== userId && game.playerOId !== userId) {
        return reply.status(403).send({ success: false, error: 'No participas en esta partida' });
      }
      if (game.status === 'FINISHED' || game.status === 'DRAW') {
        await deleteGameChat(game.chatId, gameId);
        return reply.status(403).send({ success: false, error: 'El chat no está disponible para partidas terminadas' });
      }
      let chatId = game.chatId;
      if (chatId == null) {
        const [newChat] = await db.insert(chats).values({
          user1Id: game.playerXId,
          user2Id: game.playerOId,
        }).returning({ id: chats.id });
        chatId = newChat.id;
        await db.update(games).set({ chatId }).where(eq(games.id, gameId));
      }
      const opponentId = game.playerXId === userId ? game.playerOId : game.playerXId;
      const opponentRows = await db.select({ username: users.username }).from(users).where(eq(users.id, opponentId));
      const opponentUsername = opponentRows[0]?.username ?? '';
      const messageRows = await db
        .select({
          id: messages.id,
          content: messages.content,
          createdAt: messages.createdAt,
          senderId: messages.senderId,
          senderUsername: users.username,
        })
        .from(messages)
        .leftJoin(users, eq(messages.senderId, users.id))
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.createdAt);
      const list = messageRows.map((m) => ({
        id: m.id,
        content: m.content,
        createdAt: m.createdAt,
        senderUsername: m.senderUsername ?? '?',
        isMine: m.senderId === userId,
      }));
      return reply.status(200).send({
        success: true,
        chatId,
        opponentUsername,
        messages: list,
      });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al cargar chat' });
    }
  });

  // POST /games/:id/chat/messages — enviar mensaje (solo partidas en curso)
  server.post('/:id/chat/messages', async (request, reply) => {
    const gameId = Number((request.params as { id: string }).id);
    const { content } = request.body as { content: string };
    const userId = request.user.id;
    if (!Number.isInteger(gameId) || gameId < 1) {
      return reply.status(400).send({ success: false, error: 'Id inválido' });
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      return reply.status(400).send({ success: false, error: 'Mensaje vacío' });
    }
    try {
      const rows = await db.select().from(games).where(eq(games.id, gameId));
      const game = rows[0];
      if (!game) return reply.status(404).send({ success: false, error: 'Partida no encontrada' });
      if (game.playerXId !== userId && game.playerOId !== userId) {
        return reply.status(403).send({ success: false, error: 'No participas en esta partida' });
      }
      if (game.status === 'FINISHED' || game.status === 'DRAW') {
        return reply.status(403).send({ success: false, error: 'El chat no está disponible para partidas terminadas' });
      }
      let chatId = game.chatId;
      if (chatId == null) {
        const [newChat] = await db.insert(chats).values({
          user1Id: game.playerXId,
          user2Id: game.playerOId,
        }).returning({ id: chats.id });
        chatId = newChat.id;
        await db.update(games).set({ chatId }).where(eq(games.id, gameId));
      }
      const [msg] = await db.insert(messages).values({
        chatId,
        senderId: userId,
        content: content.trim().slice(0, 2000),
      }).returning({ id: messages.id, content: messages.content, createdAt: messages.createdAt });
      const me = await db.select({ username: users.username }).from(users).where(eq(users.id, userId));
      const senderUsername = me[0]?.username ?? '';
      const recipientId = game.playerXId === userId ? game.playerOId : game.playerXId;
      const messagePayload = {
        id: msg.id,
        content: msg.content,
        createdAt: msg.createdAt,
        senderUsername,
      };
      notifyUser(recipientId, 'chat_message', {
        gameId,
        message: { ...messagePayload, isMine: false },
      });
      notifyUser(userId, 'chat_message', {
        gameId,
        message: { ...messagePayload, isMine: true },
      });
      return reply.status(201).send({ success: true });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al enviar mensaje' });
    }
  });

  // GET /games/:id — una partida (para jugar)
  server.get('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const userId = request.user.id;
    if (!Number.isInteger(id) || id < 1) {
      return reply.status(400).send({ success: false, error: 'Id inválido' });
    }
    try {
      const rows = await db.select().from(games).where(eq(games.id, id));
      const game = rows[0];
      if (!game) {
        return reply.status(404).send({ success: false, error: 'Partida no encontrada' });
      }
      if (game.playerXId !== userId && game.playerOId !== userId) {
        return reply.status(403).send({ success: false, error: 'No participas en esta partida' });
      }
      const [xUser, oUser] = await Promise.all([
        db.select({ username: users.username }).from(users).where(eq(users.id, game.playerXId)),
        db.select({ username: users.username }).from(users).where(eq(users.id, game.playerOId)),
      ]);
      const mySymbol = game.playerXId === userId ? 'X' : 'O';
      const opponentUsername = game.playerXId === userId ? oUser[0]?.username : xUser[0]?.username;
      const youWon = game.winnerId !== null && game.winnerId === userId;
      return reply.status(200).send({
        success: true,
        game: {
          id: game.id,
          boardState: game.boardState,
          playerTurn: game.playerTurn,
          status: game.status,
          winnerId: game.winnerId,
          mySymbol,
          opponentUsername: opponentUsername ?? '',
          youWon,
        },
      });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al cargar partida' });
    }
  });

  // POST /games/:id/move — hacer jugada { position: number } (0-8)
  server.post('/:id/move', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const { position } = request.body as { position: number };
    const userId = request.user.id;

    if (!Number.isInteger(id) || id < 1) {
      return reply.status(400).send({ success: false, error: 'Id inválido' });
    }
    if (typeof position !== 'number' || position < 0 || position > 8) {
      return reply.status(400).send({ success: false, error: 'position debe ser 0-8' });
    }

    try {
      const rows = await db.select().from(games).where(eq(games.id, id));
      const game = rows[0];
      if (!game) {
        return reply.status(404).send({ success: false, error: 'Partida no encontrada' });
      }
      if (game.status !== 'ACTIVE') {
        return reply.status(400).send({ success: false, error: 'Partida terminada' });
      }

      const isX = game.playerXId === userId;
      const isO = game.playerOId === userId;
      if (!isX && !isO) {
        return reply.status(403).send({ success: false, error: 'No participas en esta partida' });
      }
      const mySymbol = isX ? 'X' : 'O';
      if (game.playerTurn !== mySymbol) {
        return reply.status(400).send({ success: false, error: 'No es tu turno' });
      }

      const board = game.boardState.split('');
      if (board[position] !== '-') {
        return reply.status(400).send({ success: false, error: 'Casilla ocupada' });
      }
      board[position] = mySymbol;
      const newBoard = board.join('');

      let newStatus = game.status;
      let newTurn = game.playerTurn === 'X' ? 'O' : 'X';
      let winnerId: number | null = null;

      if (checkWinner(newBoard, mySymbol)) {
        newStatus = 'FINISHED';
        winnerId = userId;
        newTurn = game.playerTurn;
      } else if (isDraw(newBoard)) {
        newStatus = 'DRAW';
      }

      await db
        .update(games)
        .set({
          boardState: newBoard,
          playerTurn: newTurn,
          status: newStatus,
          ...(winnerId !== null && { winnerId }),
        })
        .where(eq(games.id, id));

      if (newStatus === 'FINISHED' || newStatus === 'DRAW') {
        await deleteGameChat(game.chatId, id);
      }

      const opponentId = isX ? game.playerOId : game.playerXId;
      const opponentRows = await db.select({ username: users.username }).from(users).where(eq(users.id, opponentId));
      const opponentUsername = opponentRows[0]?.username ?? '';

      notifyUser(opponentId, 'game_move', { gameId: id, opponentUsername: request.user.username });

      const youWon = winnerId === userId;
      return reply.status(200).send({
        success: true,
        game: {
          id,
          boardState: newBoard,
          playerTurn: newTurn,
          status: newStatus,
          winnerId,
          mySymbol,
          opponentUsername,
          youWon,
        },
      });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ success: false, error: 'Error al jugar' });
    }
  });
}
