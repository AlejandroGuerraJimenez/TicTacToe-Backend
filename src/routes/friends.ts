import { FastifyInstance } from 'fastify';
import { authenticate } from '../plugins/auth';
import { notifyUser } from '../plugins/realtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { users, friendships, friendRequests } from '../db/schema';
import { eq, and, or } from 'drizzle-orm';
import 'dotenv/config';

// Reutilizamos la conexión (idealmente inyectada, pero por simplicidad la creamos aquí o la importamos si exportaras db)
// Para mantener consistencia con server.ts, mejor crear una nueva instancia o pasarla como plugin options. 
// Por ahora, instanciamos aquí para no refactorizar todo server.ts.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export async function friendsRoutes(server: FastifyInstance) {

    // Proteger todas las rutas de este plugin
    server.addHook('onRequest', authenticate);

    // 1. Enviar solicitud de amistad
    // POST /friends/request { targetUsername: string }
    server.post('/request', async (request, reply) => {
        const { targetUsername } = request.body as { targetUsername: string };
        const senderId = request.user.id;

        try {
            // Buscar usuario destino
            const targetUsers = await db.select().from(users).where(eq(users.username, targetUsername));
            const targetUser = targetUsers[0];

            if (!targetUser) {
                return reply.status(404).send({ success: false, error: 'Usuario no encontrado' });
            }

            if (targetUser.id === senderId) {
                return reply.status(400).send({ success: false, error: 'No puedes enviarte solicitud a ti mismo' });
            }

            // Verificar si ya son amigos
            const existingFriendship = await db.select().from(friendships).where(
                or(
                    and(eq(friendships.userId, senderId), eq(friendships.friendId, targetUser.id)),
                    and(eq(friendships.userId, targetUser.id), eq(friendships.friendId, senderId))
                )
            );

            if (existingFriendship.length > 0) {
                return reply.status(400).send({ success: false, error: 'Ya sois amigos' });
            }

            // Verificar si ya hay solicitud pendiente
            const existingRequest = await db.select().from(friendRequests).where(
                or(
                    and(eq(friendRequests.senderId, senderId), eq(friendRequests.receiverId, targetUser.id)), // Enviada por mí
                    and(eq(friendRequests.senderId, targetUser.id), eq(friendRequests.receiverId, senderId))  // Enviada por él (que acepte esa)
                )
            );

            if (existingRequest.length > 0) {
                // Si está PENDING
                const reqWithStatus = existingRequest.find(r => r.status === 'PENDING');
                if (reqWithStatus) {
                    return reply.status(400).send({ success: false, error: 'Ya hay una solicitud pendiente' });
                }
            }

            // Crear solicitud
            await db.insert(friendRequests).values({
                senderId,
                receiverId: targetUser.id,
                status: 'PENDING'
            });

            notifyUser(targetUser.id, 'friend_request', {
                senderId,
                senderName: request.user.username
            });

            return reply.status(200).send({ success: true, message: 'Solicitud enviada' });

        } catch (error) {
            server.log.error(error);
            return reply.status(500).send({ success: false, error: 'Error al enviar solicitud' });
        }
    });

    // 2. Listar solicitudes pendientes (recibidas)
    // GET /friends/requests
    server.get('/requests', async (request, reply) => {
        const userId = request.user.id;
        try {
            // Join friendRequests con users para obtener nombre del sender
            const myRequests = await db.select({
                requestId: friendRequests.id,
                senderId: friendRequests.senderId,
                senderName: users.username,
                createdAt: friendRequests.createdAt
            })
                .from(friendRequests)
                .innerJoin(users, eq(friendRequests.senderId, users.id))
                .where(
                    and(
                        eq(friendRequests.receiverId, userId),
                        eq(friendRequests.status, 'PENDING')
                    )
                );

            return reply.status(200).send({ success: true, requests: myRequests });
        } catch (error) {
            server.log.error(error);
            return reply.status(500).send({ success: false, error: 'Error al obtener solicitudes' });
        }
    });

    // 3. Aceptar solicitud
    // POST /friends/accept/:requestId
    server.post('/accept/:requestId', async (request, reply) => {
        const { requestId } = request.params as { requestId: string };
        const userId = request.user.id;
        const reqIdNum = Number(requestId);

        try {
            // Verificar solicitud
            const requests = await db.select().from(friendRequests).where(
                and(
                    eq(friendRequests.id, reqIdNum),
                    eq(friendRequests.receiverId, userId),
                    eq(friendRequests.status, 'PENDING')
                )
            );
            const friendRequest = requests[0];

            if (!friendRequest) {
                return reply.status(404).send({ success: false, error: 'Solicitud no encontrada o inválida' });
            }

            // Eliminar la solicitud de la base de datos
            await db.delete(friendRequests).where(eq(friendRequests.id, reqIdNum));

            // Verificar si ya existe la amistad
            const existingFriendship = await db.select().from(friendships).where(
                or(
                    and(eq(friendships.userId, userId), eq(friendships.friendId, friendRequest.senderId)),
                    and(eq(friendships.userId, friendRequest.senderId), eq(friendships.friendId, userId))
                )
            );

            // Solo crear amistad si no existe (UNA SOLA FILA)
            if (existingFriendship.length === 0) {
                await db.insert(friendships).values({
                    userId: userId,
                    friendId: friendRequest.senderId
                });
            }

            notifyUser(friendRequest.senderId, 'friend_accepted', {
                userId,
                username: request.user.username
            });

            return reply.status(200).send({ success: true, message: 'Solicitud aceptada' });

        } catch (error) {
            server.log.error(error);
            return reply.status(500).send({ success: false, error: 'Error al aceptar solicitud' });
        }
    });

    // 4. Rechazar solicitud
    // POST /friends/reject/:requestId
    server.post('/reject/:requestId', async (request, reply) => {
        const { requestId } = request.params as { requestId: string };
        const userId = request.user.id;
        const reqIdNum = Number(requestId);

        try {
            const requests = await db.select().from(friendRequests).where(
                and(
                    eq(friendRequests.id, reqIdNum),
                    eq(friendRequests.receiverId, userId),
                    eq(friendRequests.status, 'PENDING')
                )
            );

            if (!requests[0]) {
                return reply.status(404).send({ success: false, error: 'Solicitud no encontrada' });
            }

            const senderId = requests[0].senderId;
            await db.delete(friendRequests).where(eq(friendRequests.id, reqIdNum));

            notifyUser(senderId, 'friend_rejected', {
                userId,
                username: request.user.username
            });

            return reply.status(200).send({ success: true, message: 'Solicitud rechazada' });
        } catch (error) {
            server.log.error(error);
            return reply.status(500).send({ success: false, error: 'Error al rechazar solicitud' });
        }
    });


    // 5. Listar amigos
    // GET /friends
    server.get('/', async (request, reply) => {
        const userId = request.user.id;
        try {
            // Buscar amistades donde el usuario esté en CUALQUIERA de las dos columnas
            const friendshipsAsUser = await db.select({
                id: users.id,
                username: users.username,
                email: users.email,
                friendshipDate: friendships.createdAt
            })
                .from(friendships)
                .innerJoin(users, eq(friendships.friendId, users.id))
                .where(eq(friendships.userId, userId));

            const friendshipsAsFriend = await db.select({
                id: users.id,
                username: users.username,
                email: users.email,
                friendshipDate: friendships.createdAt
            })
                .from(friendships)
                .innerJoin(users, eq(friendships.userId, users.id))
                .where(eq(friendships.friendId, userId));

            // Combinar ambos resultados y eliminar duplicados por ID
            const allFriends = [...friendshipsAsUser, ...friendshipsAsFriend];
            const uniqueFriends = Array.from(new Map(allFriends.map(f => [f.id, f])).values());

            return reply.status(200).send({ success: true, friends: uniqueFriends });

        } catch (error) {
            server.log.error(error);
            return reply.status(500).send({ success: false, error: 'Error al obtener amigos' });
        }
    });

    // 6. Eliminar amigo
    // DELETE /friends/:friendId  (friendId = id del usuario amigo, no el id de la fila friendship)
    server.delete('/:friendId', async (request, reply) => {
        const rawFriendId = (request.params as { friendId: string }).friendId;
        const friendId = Number(rawFriendId);
        const userId = Number(request.user.id);

        if (Number.isNaN(friendId) || friendId < 1 || !Number.isInteger(friendId)) {
            return reply.status(400).send({
                success: false,
                error: 'friendId inválido'
            });
        }
        if (Number.isNaN(userId) || userId < 1) {
            return reply.status(401).send({
                success: false,
                error: 'Usuario no identificado'
            });
        }
        if (userId === friendId) {
            return reply.status(400).send({
                success: false,
                error: 'No puedes eliminarte a ti mismo'
            });
        }

        try {
            const result = await db.delete(friendships).where(
                or(
                    and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)),
                    and(eq(friendships.userId, friendId), eq(friendships.friendId, userId))
                )
            ).returning();

            if (result.length === 0) {
                return reply.status(404).send({
                    success: false,
                    message: 'No se encontró la relación de amistad para borrar.'
                });
            }

            notifyUser(friendId, 'friend_removed', { userId });

            return reply.status(200).send({ success: true, message: 'Amigo eliminado' });
        } catch (error) {
            server.log.error(error);
            return reply.status(500).send({ success: false, error: 'Error interno' });
        }
    });

}
