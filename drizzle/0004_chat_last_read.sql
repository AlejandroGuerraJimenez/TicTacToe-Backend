-- Lectura de mensajes: cuándo leyó cada usuario el chat
ALTER TABLE "chat" ADD COLUMN IF NOT EXISTS "user1_last_read_at" timestamp;
ALTER TABLE "chat" ADD COLUMN IF NOT EXISTS "user2_last_read_at" timestamp;
