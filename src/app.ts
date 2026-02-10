import Fastify from 'fastify';
import cors from '@fastify/cors';
import bcrypt from 'bcrypt';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { users } from './db/schema'; //
import 'dotenv/config'; //


export function buildApp() {
  const app = Fastify({ logger: true });                    

  //Configuración de la base de datos
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);                                              
  
  // Habilitar CORS
  app.register(cors, {origin: '*'}); 

  // Ruta POST para el registro
  app.post('/register', async (request, reply) => {

    const { username, email, password } = request.body as { username: string; email: string; password: string }; //
    
    console.log(request);
    
    try {
      // Hasheamos la contraseña
      const hashedPassword = await bcrypt.hash(password, 10);

      // Insertamos el nuevo usuario
      const newUser = await db.insert(users).values({ username, email, password: hashedPassword }).returning();
      return reply.status(201).send({ success: true, user: newUser });

    } catch (error) {
      reply.status(500).send({ success: false, error: 'Registration failed' }); //
    }
  });

  return app; // Retornamos la instancia para poder usarla en server.ts
}