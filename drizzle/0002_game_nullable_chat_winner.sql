-- Hacer chat_id y winner_id opcionales para poder crear partidas sin chat y sin ganador
ALTER TABLE "game" ALTER COLUMN "chat_id" DROP NOT NULL;
ALTER TABLE "game" ALTER COLUMN "chat_id" DROP DEFAULT;
ALTER TABLE "game" ALTER COLUMN "winner_id" DROP NOT NULL;
ALTER TABLE "game" ALTER COLUMN "winner_id" DROP DEFAULT;
