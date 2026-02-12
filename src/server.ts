import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import bcrypt from 'bcrypt';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { users } from './db/schema';
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

// 1. Configuración de la base de datos (Traído de app.ts)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

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
  const { username, email, password } = request.body as any;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await db.insert(users).values({
      username,
      email,
      password: hashedPassword
    }).returning();

    // No devolvemos el password al cliente
    const { password: _pw, ...safeUser } = newUser[0];

    // Generamos JWT
    const token = server.jwt.sign({ id: safeUser.id, username: safeUser.username, email: safeUser.email });

    // Guardamos en cookie httpOnly
    reply.setCookie('token', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // true en prod con HTTPS
      maxAge: 60 * 60 * 24 * 7, // 7 días
    });

    return reply.status(201).send({ success: true, user: safeUser, token }); // Devolvemos token también por si acaso
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ success: false, error: 'Registration failed' });
  }
});

// 4. Ruta de login (recuperar datos de una BD y validar contraseña)
server.post('/login', async (request, reply) => {
  const { username, email, password } = request.body as any;

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

// 5. Ruta para obtener el usuario actual a partir del JWT cookie
server.get('/me', {
  onRequest: [authenticate]
}, async (request, reply) => {
  // request.user ya está poblado por el middleware
  return reply.status(200).send({ success: true, user: request.user });
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