import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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

const userRef = () =>
  text("user_id")
    .notNull()
    .references(() => users.id);

export const spheres = sqliteTable(
  "spheres",
  {
    id: text("id").primaryKey(),
    userId: userRef(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("spheres_user_name").on(t.userId, t.name)],
);

export const actionKinds = sqliteTable(
  "action_kinds",
  {
    id: text("id").primaryKey(),
    userId: userRef(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("action_kinds_user_name").on(t.userId, t.name)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: userRef(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("categories_user_name").on(t.userId, t.name)],
);

export const categoryCompat = sqliteTable(
  "category_compat",
  {
    userId: userRef(),
    categoryA: text("category_a")
      .notNull()
      .references(() => categories.id),
    categoryB: text("category_b")
      .notNull()
      .references(() => categories.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.categoryA, t.categoryB] })],
);

export const rewards = sqliteTable(
  "rewards",
  {
    id: text("id").primaryKey(),
    userId: userRef(),
    title: text("title").notNull(),
    minutes: integer("minutes").notNull(),
  },
  (t) => [index("rewards_user").on(t.userId)],
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["inbox", "idea", "task", "routine", "practice"] }).notNull(),
    title: text("title").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    creatorId: text("creator_id")
      .notNull()
      .references(() => users.id),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id),
    source: text("source", { enum: ["bot", "web", "mcp", "import"] }).notNull(),
    assignState: text("assign_state", { enum: ["none", "pending", "accepted", "declined"] })
      .notNull()
      .default("none"),
    archivedAt: integer("archived_at"),
    archiveReason: text("archive_reason", { enum: ["done", "irrelevant"] }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("items_owner_kind").on(t.ownerId, t.kind, t.archivedAt),
    index("items_creator").on(t.creatorId),
    index("items_archived_at").on(t.archivedAt),
  ],
);

export const itemSpheres = sqliteTable(
  "item_spheres",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    sphereId: text("sphere_id")
      .notNull()
      .references(() => spheres.id),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.sphereId] }), index("item_spheres_sphere").on(t.sphereId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id")
      .primaryKey()
      .references(() => items.id, { onDelete: "cascade" }),
    important: integer("important", { mode: "boolean" }),
    urgent: integer("urgent", { mode: "boolean" }),
    impactful: integer("impactful", { mode: "boolean" }),
    easy: integer("easy", { mode: "boolean" }),
    why: text("why"),
    actionKindId: text("action_kind_id").references(() => actionKinds.id),
    categoryId: text("category_id").references(() => categories.id),
    deadline: integer("deadline"),
    remindAt: integer("remind_at"),
    projectId: text("project_id").references((): AnySQLiteColumn => tasks.id),
    isProject: integer("is_project", { mode: "boolean" }).notNull().default(false),
    stepPos: integer("step_pos"),
    parentTaskId: text("parent_task_id").references((): AnySQLiteColumn => tasks.id),
    deferred: integer("deferred", { mode: "boolean" }).notNull().default(false),
    deferredUntil: integer("deferred_until"),
    queued: integer("queued", { mode: "boolean" }).notNull().default(false),
    queuedAfterId: text("queued_after_id").references((): AnySQLiteColumn => tasks.id),
    waitingFor: text("waiting_for"),
    waitingSince: integer("waiting_since"),
    flavor: text("flavor", { enum: ["dopamine", "frog"] }),
    frogAuto: integer("frog_auto", { mode: "boolean" }).notNull().default(false),
    skipCount: integer("skip_count").notNull().default(0),
    lastShownAt: integer("last_shown_at"),
    firstStepVoiceId: text("first_step_voice_id"),
    firstStepText: text("first_step_text"),
    inFocus: integer("in_focus", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("tasks_project").on(t.projectId, t.stepPos),
    index("tasks_deadline").on(t.deadline),
    index("tasks_remind_at").on(t.remindAt),
  ],
);

export const routines = sqliteTable("routines", {
  id: text("id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  period: text("period", { enum: ["zone", "daily", "weekly", "monthly", "yearly"] }).notNull(),
  partOfDay: text("part_of_day", { enum: ["morning", "day", "evening"] }),
  weekday: integer("weekday"),
  zoneNo: integer("zone_no"),
  position: integer("position").notNull(),
});

export const practices = sqliteTable("practices", {
  id: text("id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  unit: text("unit"),
  totalGoal: integer("total_goal"),
  minAmount: integer("min_amount"),
  minPeriod: text("min_period", { enum: ["day", "week", "month"] }),
});

export const zones = sqliteTable(
  "zones",
  {
    userId: userRef(),
    no: integer("no").notNull(),
    name: text("name").notNull(),
    currentRound: integer("current_round").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.userId, t.no] })],
);

export const insights = sqliteTable(
  "insights",
  {
    id: text("id").primaryKey(),
    userId: userRef(),
    text: text("text").notNull(),
  },
  (t) => [index("insights_user").on(t.userId)],
);

export const insightSpheres = sqliteTable(
  "insight_spheres",
  {
    insightId: text("insight_id")
      .notNull()
      .references(() => insights.id, { onDelete: "cascade" }),
    sphereId: text("sphere_id")
      .notNull()
      .references(() => spheres.id),
  },
  (t) => [primaryKey({ columns: [t.insightId, t.sphereId] })],
);
