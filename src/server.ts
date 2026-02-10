import Fastify from 'fastify';
import cors from '@fastify/cors';
import bcrypt from 'bcrypt';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { users } from './db/schema'; // Asegúrate de que esta ruta sea correcta
import 'dotenv/config';

const server = Fastify({ logger: true });

// 1. Configuración de la base de datos (Traído de app.ts)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// 2. Registro de plugins
server.register(cors, { origin: '*' });

// 3. Ruta de registro (La lógica que tenías en app.ts)
server.post('/register', async (request, reply) => {
  const { username, email, password } = request.body as any;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await db.insert(users).values({ 
      username, 
      email, 
      password: hashedPassword 
    }).returning();

    return reply.status(201).send({ success: true, user: newUser[0] });
  } catch (error) {
    server.log.error(error);
    return reply.status(500).send({ success: false, error: 'Registration failed' });
  }
});

// 4. Ruta de prueba
server.get('/ping', async () => {
  return { pong: 'it works!' };
});

// 5. Arranque del servidor
const start = async () => {
  try {
    await server.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();