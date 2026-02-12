-- Añadir sender_id a message para saber quién envió cada mensaje
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "sender_id" integer REFERENCES "user"("id");
