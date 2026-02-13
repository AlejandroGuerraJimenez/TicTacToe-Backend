import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { users } from './db/schema';
import { db } from './db/connection';
import type { RegisterBody, LoginBody, UpdateProfileBody } from './types/dto';
import { authenticate } from './plugins/auth';
import { realtimePlugin } from './plugins/realtime';
import { friendsRoutes } from './routes/friends';
import { gamesRoutes } from './routes/games';
import 'dotenv/config';

// Define custom types for JWT
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: number; username: string; email: string };
    user: { id: number; username: string; email: string };
  }
}

const server = Fastify({ logger: true });

// 1. Base de datos: una sola instancia compartida (véase db/connection.ts)

// 2. Registro de plugins
server.register(cors, {
  origin: 'http://localhost:4200',
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
});

server.register(jwt, {
  secret: process.env.JWT_SECRET || 'supersecret',
  cookie: {
    cookieName: 'token',
    signed: false, // JWT ya está firmado
  },
});

server.register(cookie, {
  secret: process.env.COOKIE_SECRET || 'cookie-secret',
});

server.register(realtimePlugin);

server.register(friendsRoutes, { prefix: '/friends' });
server.register(gamesRoutes, { prefix: '/games' });

server.post('/register', async (request, reply) => {
  const body = request.body as RegisterBody;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!username || username.length < 4) {
    return reply.status(400).send({ success: false, error: 'El nombre de usuario es obligatorio (mín. 4 caracteres)' });
  }
  if (!email) {
    return reply.status(400).send({ success: false, error: 'El correo electrónico es obligatorio' });
  }
  if (!password || password.length < 6) {
    return reply.status(400).send({ success: false, error: 'La contraseña es obligatoria (mín. 6 caracteres)' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await db.insert(users).values({
      username,
      email,
      password: hashedPassword
    }).returning();

    const { password: _pw, ...safeUser } = newUser[0];
    const token = server.jwt.sign({ id: safeUser.id, username: safeUser.username, email: safeUser.email });

    reply.setCookie('token', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 60 * 60 * 24 * 7,
    });

    return reply.status(201).send({ success: true, user: safeUser, token });
  } catch (error: any) {
    server.log.error(error);
    if (error?.code === '23505') {
      return reply.status(409).send({ success: false, error: 'El nombre de usuario o el correo ya están en uso' });
    }
    return reply.status(500).send({ success: false, error: 'Error al crear la cuenta. Inténtalo de nuevo.' });
  }
});

// 4. Ruta de login (recuperar datos de una BD y validar contraseña)
server.post('/login', async (request, reply) => {
  const { username, email, password } = request.body as LoginBody;

  if (!password || !email) {
    return reply.status(400).send({ success: false, error: 'Faltan credenciales' });
  }

  try {
    // Buscar usuario por username o por email
    const foundUsers = await db
      .select()
      .from(users)
      .where(username ? eq(users.username, username) : eq(users.email, email));
    const user = foundUsers[0];

    if (!user) {
      return reply.status(401).send({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    // Comparar contraseña
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return reply.status(401).send({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    // Generamos JWT
    const token = server.jwt.sign({ id: user.id, username: user.username, email: user.email });

    // Crear cookie de sesión (ahora es el JWT)
    reply.setCookie('token', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 60 * 60 * 24 * 7, // 7 días
    });

    // Devolver datos seguros (sin password)
    const { password: _pw, ...safeUser } = user;

    return reply.status(200).send({ success: true, user: safeUser, token }); // Devolvemos token explícitamente como pidió el usuario
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ success: false, error: 'Login failed' });
  }
});

// 5. Ruta para obtener el usuario actual: siempre desde la BD (así tras cambiar perfil, al recargar se ven los datos nuevos)
server.get('/me', {
  onRequest: [authenticate]
}, async (request, reply) => {
  const userId = request.user.id;
  const [user] = await db
    .select({ id: users.id, username: users.username, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) {
    return reply.status(404).send({ success: false, error: 'Usuario no encontrado' });
  }
  return reply.status(200).send({ success: true, user });
});

// 5b. Actualizar perfil (username, email)
server.patch('/me', {
  onRequest: [authenticate]
}, async (request, reply) => {
  const userId = request.user.id;
  const body = request.body as UpdateProfileBody;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim() : '';

  if (!username && !email) {
    return reply.status(400).send({ success: false, error: 'Indica username o email para actualizar' });
  }
  if (username && username.length < 2) {
    return reply.status(400).send({ success: false, error: 'El nombre de usuario debe tener al menos 2 caracteres' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (email && !emailRegex.test(email)) {
    return reply.status(400).send({ success: false, error: 'Correo electrónico no válido' });
  }

  try {
    const updates: { username?: string; email?: string } = {};
    if (username) updates.username = username;
    if (email) updates.email = email;

    if (updates.username) {
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, updates.username));
      if (existing.length > 0 && existing[0].id !== userId) {
        return reply.status(409).send({ success: false, error: 'Ese nombre de usuario ya está en uso' });
      }
    }
    if (updates.email) {
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, updates.email));
      if (existing.length > 0 && existing[0].id !== userId) {
        return reply.status(409).send({ success: false, error: 'Ese correo ya está en uso' });
      }
    }

    const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning({
      id: users.id,
      username: users.username,
      email: users.email,
      createdAt: users.createdAt,
    });
    if (!updated) return reply.status(404).send({ success: false, error: 'Usuario no encontrado' });

    return reply.status(200).send({ success: true, user: updated });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ success: false, error: 'Error al actualizar el perfil' });
  }
});

// 6. Ruta de logout: borrar cookie de sesión
server.post('/logout', async (_request, reply) => {
  reply.clearCookie('token', { path: '/' });
  return reply.status(200).send({ success: true });
});

// 7. Arranque del servidor
const start = async () => {
  try {
    await server.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();