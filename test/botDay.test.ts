import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, createUser, mockTelegram, resetDb, type TelegramCall } from "./helpers";

const NOW = "2026-11-10T12:00:00Z";
const D = "2026-11-10";
const from = { id: 1001, first_name: "Ann", language_code: "ru" };
let updateId = 5000;
let calls: TelegramCall[];
let ann: { id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  await resetDb();
  ann = await createUser(1001, "Ann");
  calls = mockTelegram();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function post(update: Record<string, unknown>) {
  return call("/tg/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  });
}

const press = (data: string, messageId = 50, text = "") =>
  post({
    callback_query: {
      id: String(updateId),
      from: { ...from, is_bot: false },
      chat_instance: "1",
      data,
      message: { message_id: messageId, date: 0, chat: { id: from.id, type: "private" }, text },
    },
  });

const reply = (text: string, replyTo: number) =>
  post({
    message: {
      message_id: 900 + updateId,
      date: 0,
      chat: { id: from.id, type: "private" },
      from: { ...from, is_bot: false },
      text,
      reply_to_message: {
        message_id: replyTo,
        date: 0,
        chat: { id: from.id, type: "private" },
        from: { id: 1, is_bot: true, first_name: "TaskBuddy" },
        text: "?",
      },
    },
  });

async function insertTask(title: string, fields: Record<string, string | number | null> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const columns = Object.keys(fields);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, kind, title, owner_id, creator_id, household_id, source, created_at, updated_at)
      SELECT ?, 'task', ?, id, id, household_id, 'web', 0, 0 FROM users WHERE id = ?`,
    ).bind(id, title, ann.id),
    env.DB.prepare(
      `INSERT INTO tasks (id${columns.map((c) => `, ${c}`).join("")}) VALUES (?${columns.map(() => ", ?").join("")})`,
    ).bind(id, ...Object.values(fields)),
  ]);
  return id;
}

const sent = (method: string) => calls.filter((c) => c.method === method);
const buttons = (c: TelegramCall) =>
  ((c.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })?.inline_keyboard ?? []).flat();

describe("бот: пять кнопок и карточка задачи", () => {
  it("«Выбрать» присылает ссылку «TaskBuddy», которая входит на страницу в режиме выбора", async () => {
    await press("w");
    const message = sent("sendMessage").at(-1)!;
    expect(message.payload.parse_mode).toBe("HTML");
    const link = /^<a href="([^"]+)">TaskBuddy<\/a>$/.exec(String(message.payload.text));
    const url = new URL(link![1].replaceAll("&amp;", "&"));
    expect(url.searchParams.get("pick")).toBe("1");
    const signIn = await call("/api/auth/link", { method: "POST", body: JSON.stringify({ token: url.searchParams.get("login") }) });
    expect(signIn.status).toBe(200);
  });

  it("кнопка дает задачу с «Принять» / «Отказаться»; «Принять» меняет карточку и присылает список последним", async () => {
    await insertTask("позвонить маме", { important: 1, why: "давно не звонила" });
    await press(`b|${D}|important`);
    const shown = sent("sendMessage").at(-1)!;
    expect(shown.payload.text).toBe("Важная: позвонить маме");
    expect(buttons(shown).map((b) => b.callback_data)).toEqual([`d|${D}|important|0|accept`, `d|${D}|important|0|refuse`]);

    await press(`d|${D}|important|0|accept`);
    const edited = sent("editMessageText").at(-1)!;
    expect(buttons(edited).map((b) => b.text)).toEqual(["Сделано", "Таймер"]);
    expect(sent("sendMessage").at(-1)!.payload.text).toBe("Список на сегодня\n\n• позвонить маме");
    const user = await env.DB.prepare("SELECT list_message_id FROM users WHERE id = ?").bind(ann.id).first<{ list_message_id: number }>();
    expect(user?.list_message_id).toBe(1);

    const list = sent("sendMessage").at(-1)!;
    expect(buttons(list).map((b) => [b.text, b.callback_data])).toEqual([
      ["Сделано: позвонить маме", `l|${D}|important|0`],
      ["Таймер", `tm|${D}|important|0`],
    ]);

    await press(`d|${D}|important|0|done`);
    expect(sent("deleteMessage").at(-1)!.payload.message_id).toBe(1);
    expect(sent("sendMessage").at(-1)!.payload.text).toBe("Список на сегодня\n\n✓ позвонить маме");
  });

  it("устаревшая кнопка (вчерашняя карточка) показывает актуальное состояние", async () => {
    await insertTask("задача", { important: 1, why: "x" });
    await press(`d|2026-11-09|important|0|accept`);
    expect(String(sent("editMessageText").at(-1)!.payload.text)).toMatch(/^Это уже изменилось, вот как сейчас/);
  });

  it("отказ: «зачем», вопрос «Что мешает?» ответом на сообщение, ответ — в инсайты, затем замена", async () => {
    for (let i = 0; i < 5; i++) await insertTask(`задача ${i}`, { important: 1, why: "нужно" });
    await press(`b|${D}|important`);
    await press(`d|${D}|important|0|refuse`);
    const why = sent("editMessageText").at(-1)!;
    expect(String(why.payload.text)).toContain("Зачем: нужно");
    expect(buttons(why).map((b) => b.callback_data)).toEqual([`d|${D}|important|0|accept`, `d|${D}|important|0|wr`, `d|${D}|important|0|sw`]);

    await press(`d|${D}|important|0|sw`);
    const question = sent("sendMessage").at(-1)!;
    expect(question.payload.text).toBe("Что мешает?\nОтветь на это сообщение");
    expect(question.payload.reply_markup).toEqual({ force_reply: true });

    await reply("устала", 1);
    const insights = await env.DB.prepare("SELECT text FROM insights").all<{ text: string }>();
    expect(insights.results.map((row) => row.text)).toEqual(["устала"]);
    expect(sent("setMessageReaction")).toHaveLength(1);
    const replaced = sent("editMessageText").at(-1)!;
    expect(buttons(replaced).map((b) => b.callback_data)).toEqual([`d|${D}|important|1|accept`, `d|${D}|important|1|refuse`]);
  });

  it("обычный текст и ответ не на вопрос бота уходят в инбокс", async () => {
    await reply("купить хлеб", 77);
    const inbox = await env.DB.prepare("SELECT title FROM items WHERE kind = 'inbox'").all<{ title: string }>();
    expect(inbox.results.map((row) => row.title)).toEqual(["купить хлеб"]);
  });
});

describe("бот: вечерний опрос и напоминания", () => {
  it("ответ опроса с «Что мешает?»: «Пропустить» записывает ответ без инсайта, затем «Опрос пройден» и утро", async () => {
    const id = await insertTask("вчерашняя");
    await env.DB.prepare(
      "INSERT INTO day_plan (user_id, date, slot, position, item_id, state, hidden, created_at) VALUES (?, '2026-11-09', 'picked', 0, ?, 'accepted', 0, 0)",
    )
      .bind(ann.id, id)
      .run();
    await press("s|2026-11-09|picked|0|back", 60);
    expect(String(sent("editMessageText").at(-1)!.payload.text)).toContain("Что мешает?");
    expect(sent("sendMessage").at(-1)!.payload.reply_markup).toEqual({ force_reply: true });

    await press("s|2026-11-09|picked|0|back|k", 60);
    expect(sent("deleteMessage").map((c) => c.payload.message_id)).toContain(1);
    expect(String(sent("editMessageText").at(-1)!.payload.text)).toMatch(/✓ В хранилище$/);
    const texts = sent("sendMessage").map((c) => c.payload.text);
    expect(texts).toContain("Опрос пройден");
    expect(texts).toContain("Выдай мне дело");
    const task = await env.DB.prepare("SELECT skip_count FROM tasks WHERE id = ?").bind(id).first<{ skip_count: number }>();
    expect(task?.skip_count).toBe(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM insights").first<{ n: number }>())?.n).toBe(0);
  });

  it("«Взять сегодня» добавляет задачу в список; «Напомнить снова завтра» ставит то же время", async () => {
    const id = await insertTask("позвонить");
    await press(`r|t|${id}`, 70, "Напоминание: позвонить");
    expect(sent("editMessageText").at(-1)!.payload.text).toBe("Напоминание: позвонить\n\n✓ Взять сегодня");
    expect(sent("sendMessage").at(-1)!.payload.text).toBe("Список на сегодня\n\n• позвонить");

    await press(`r|a|${id}|${Date.parse("2026-11-10T11:00:00Z")}`, 71, "Напоминание: позвонить");
    const task = await env.DB.prepare("SELECT remind_at FROM tasks WHERE id = ?").bind(id).first<{ remind_at: number }>();
    expect(task?.remind_at).toBe(Date.parse("2026-11-11T11:00:00Z"));
  });

  it("«Сделано» в списке отмечает задачу ✓ и присылает список заново", async () => {
    const id = await insertTask("позвонить");
    await press(`r|t|${id}`, 70, "Напоминание: позвонить");
    await press(`l|${D}|picked|0`, 1);
    const list = sent("sendMessage").at(-1)!;
    expect(list.payload.text).toBe("Список на сегодня\n\n✓ позвонить");
    expect(buttons(list)).toEqual([]);
  });

  it("кнопка напоминания, которая не сработала, не ставит ✓; пока вчерашний опрос не пройден, сначала он", async () => {
    const gone = await insertTask("удаленная");
    await env.DB.prepare("UPDATE items SET archived_at = 1 WHERE id = ?").bind(gone).run();
    await press(`r|a|${gone}|${Date.parse("2026-11-10T11:00:00Z")}`, 71, "Напоминание: удаленная");
    expect(sent("editMessageText").at(-1)!.payload.text).toBe("Напоминание: удаленная\n\nЭто уже изменилось, вот как сейчас");

    const yesterday = await insertTask("вчерашняя");
    await env.DB.prepare(
      "INSERT INTO day_plan (user_id, date, slot, position, item_id, state, hidden, created_at) VALUES (?, '2026-11-09', 'picked', 0, ?, 'accepted', 0, 0)",
    )
      .bind(ann.id, yesterday)
      .run();
    const id = await insertTask("позвонить");
    const edits = sent("editMessageText").length;
    await press(`r|t|${id}`, 72, "Напоминание: позвонить");
    expect(sent("editMessageText")).toHaveLength(edits);
    expect(sent("sendMessage").map((c) => c.payload.text)).toContain("Сначала вчерашний опрос");
    const plan = await env.DB.prepare("SELECT count(*) AS n FROM day_plan WHERE item_id = ?").bind(id).first<{ n: number }>();
    expect(plan?.n).toBe(0);
  });

  it("причина отказа, присланная после полуночи, не записывается в сегодняшний план", async () => {
    await env.DB.prepare(
      "INSERT INTO bot_prompts (user_id, message_id, card_message_id, kind, date, slot, position, created_at) VALUES (?, 40, 30, 'reason', '2026-11-09', 'important', 0, 0)",
    )
      .bind(ann.id)
      .run();
    await insertTask("задача", { important: 1, why: "x" });
    await reply("устала", 40);
    const notes = await env.DB.prepare("SELECT count(*) AS n FROM tasks WHERE refusal_note IS NOT NULL").first<{ n: number }>();
    expect(notes?.n).toBe(0);
  });
});
