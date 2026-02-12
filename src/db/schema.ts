import { pgTable, serial, integer, varchar, text, timestamp } from "drizzle-orm/pg-core"; 

export const users = pgTable("user", {
    id: serial("id").primaryKey(),
    username: varchar("username", { length: 50 }).notNull().unique(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    password: text("password").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const games = pgTable("game", {
    id: serial("id").primaryKey(),
    playerXId: serial("player_x_id").notNull().references(() => users.id),
    playerOId: serial("player_o_id").notNull().references(() => users.id),
    chatId: integer("chat_id").references(() => chats.id),
    boardState: text("board_state").notNull(),
    playerTurn: varchar("current_player", { length: 1 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    winnerId: integer("winner_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}); 

export const friendRequests = pgTable("friend_request", {
    id: serial("id").primaryKey(),
    senderId: serial("sender_id").notNull().references(() => users.id),
    receiverId: serial("receiver_id").notNull().references(() => users.id),
    status: varchar("status", { length: 20 }).notNull(), // PENDING | ACCEPTED | REJECTED
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const friendships = pgTable("friendship", {
    id: serial("id").primaryKey(),
    userId: serial("user_id").notNull().references(() => users.id),
    friendId: serial("friend_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});


export const messages = pgTable("message", {
    id: serial("id").primaryKey(),
    chatId: serial("chat_id").notNull().references(() => chats.id),
    senderId: serial("sender_id").notNull().references(() => users.id),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chats = pgTable("chat", {
    id: serial("id").primaryKey(),
    user1Id: serial("user1_id").notNull().references(() => users.id),
    user2Id: serial("user2_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const gameInvitations = pgTable("game_invitation", {
    id: serial("id").primaryKey(),
    senderId: serial("sender_id").notNull().references(() => users.id),
    receiverId: serial("receiver_id").notNull().references(() => users.id),
    status: varchar("status", { length: 20 }).notNull(), // PENDING | ACCEPTED | REJECTED
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
