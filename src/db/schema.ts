import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const households = sqliteTable("households", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id),
  telegramId: integer("telegram_id").notNull().unique(),
  name: text("name").notNull(),
  language: text("language").notNull(),
  timezone: text("timezone").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable(
  "settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: ["session", "login_link"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
  },
  (t) => [index("sessions_expires_at").on(t.expiresAt)],
);

export const tgUpdates = sqliteTable(
  "tg_updates",
  {
    updateId: integer("update_id").primaryKey(),
    receivedAt: integer("received_at").notNull(),
  },
  (t) => [index("tg_updates_received_at").on(t.receivedAt)],
);
