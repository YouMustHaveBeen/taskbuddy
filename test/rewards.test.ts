import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerAlarm } from "../src/jobs/timerAlarm";
import { api, call, createUser, mockTelegram, resetDb, type TelegramCall } from "./helpers";

// не менять: настоящий будильник Durable Object сработал бы во время теста
const NOW = "2054-11-10T12:00:00Z";
const D = "2054-11-10";
const from = { id: 1001, first_name: "Ann", language_code: "ru" };
let updateId = 9000;
let calls: TelegramCall[];
let ann: { id: string; token: string };

type Reward = { position: number; open: boolean; title: string | null; minutes: number | null };
type Row = { slot: string; position: number; itemId: string; state: string; title: string; hidden: boolean; firstStep: string | null; hasVoice: boolean };
type Today = { buttons: Record<string, Row | undefined>; list: Row[]; rewards: Reward[] };
type Timer = { kind: string; itemId: string; title: string; minutes: number; state: string; endsAt: number | null };

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

async function insertReward(title: string, minutes: number): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO rewards (id, user_id, title, minutes) VALUES (?, ?, ?, ?)").bind(id, ann.id, title, minutes).run();
  return id;
}

async function post(path: string, body: unknown = {}) {
  const response = await api(ann.token, "POST", path, body);
  return { status: response.status, body: await response.json<{ timer: Timer | null } & Today>() };
}

const today = async (): Promise<Today> => (await api(ann.token, "GET", "/today")).json<Today>();
const later = (minutes: number) => vi.setSystemTime(new Date(Date.parse(NOW) + minutes * 60_000));

function webhook(update: Record<string, unknown>) {
  return call("/tg/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  });
}

const press = (data: string, messageId = 50, text = "") =>
  webhook({
    callback_query: {
      id: String(updateId),
      from: { ...from, is_bot: false },
      chat_instance: "1",
      data,
      message: { message_id: messageId, date: 0, chat: { id: from.id, type: "private" }, text },
    },
  });

const botMessage = (replyTo: number | undefined, content: Record<string, unknown>) =>
  webhook({
    message: {
      message_id: 900 + updateId,
      date: 0,
      chat: { id: from.id, type: "private" },
      from: { ...from, is_bot: false },
      ...content,
      ...(replyTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: replyTo,
              date: 0,
              chat: { id: from.id, type: "private" },
              from: { id: 1, is_bot: true, first_name: "TaskBuddy" },
              text: "?",
            },
          }),
    },
  });

const voice = (fileId: string, replyTo?: number) =>
  botMessage(replyTo, { voice: { file_id: fileId, file_unique_id: `u-${fileId}`, duration: 3 } });

const sent = (method: string) => calls.filter((c) => c.method === method);
const buttons = (c: TelegramCall) =>
  ((c.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })?.inline_keyboard ?? []).flat();

const voiceOf = async (id: string) =>
  (await env.DB.prepare("SELECT first_step_voice_id FROM tasks WHERE id = ?").bind(id).first<{ first_step_voice_id: string | null }>())
    ?.first_step_voice_id;

describe("награды в списке на сегодня", () => {
  it("на N задач N + 1 награда; открыта перед первой несделанной, выбор не меняется; без наград — пусто", async () => {
    const call1 = await insertTask("позвонить маме", { important: 1 });
    const call2 = await insertTask("купить хлеб");
    await today();
    await post("/today/important/0/reveal");
    await post("/today/important/0/accept");
    expect((await today()).rewards).toEqual([]);

    await insertReward("почитать книгу", 5);
    await insertReward("планка", 3);
    const first = await today();
    expect(first.rewards.map((r) => [r.position, r.open, r.title === null])).toEqual([
      [0, true, false],
      [1, false, true],
    ]);
    // выбор награды записан и при новом чтении тот же
    expect((await today()).rewards[0].title).toBe(first.rewards[0].title);

    // вторая задача стоит за одной из других кнопок
    const slot = Object.values(first.buttons).find((row) => row?.itemId === call2)!.slot;
    await post(`/today/${slot}/0/reveal`);
    await post(`/today/${slot}/0/accept`);
    const two = await today();
    expect(two.list.map((r) => r.itemId).sort()).toEqual([call1, call2].sort());
    expect(two.rewards).toHaveLength(3);

    const done = await post(`/today/${slot}/0/done`);
    expect(done.status).toBe(200);
    // сделанная задача идет первой; прошедшая награда с названием, открыта следующая
    expect(done.body.list.map((r) => [r.itemId, r.state])).toEqual([
      [call2, "done"],
      [call1, "accepted"],
    ]);
    expect(done.body.rewards.map((r) => [r.open, r.title === null])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
    expect(done.body.rewards[0].title).toBe(first.rewards[0].title);
  });

  it("«Старт» у открытой награды: таймер на ее длину; после конца только «Завершить»", async () => {
    const id = await insertReward("почитать книгу", 5);
    await insertTask("позвонить маме", { important: 1 });
    await today();
    await post("/today/important/0/reveal");
    await post("/today/important/0/accept");

    expect((await post("/timer/reward/1")).status).toBe(404);
    const started = await post("/timer/reward/0");
    expect(started.status).toBe(200);
    expect(started.body.timer).toMatchObject({ kind: "reward", itemId: id, title: "почитать книгу", minutes: 5, state: "running" });
    expect(started.body.timer?.endsAt).toBe(Date.parse(NOW) + 5 * 60_000);
    // пока идет таймер награды, второй таймер не запускается
    expect((await post("/timer/start/important/0/10")).status).toBe(409);

    expect((await post("/timer/finish")).status).toBe(400);
    later(5);
    expect((await post("/timer/later")).status).toBe(400);
    expect((await post("/timer/again/5")).status).toBe(400);
    const finished = await post("/timer/finish");
    expect(finished.status).toBe(200);
    expect(finished.body.timer).toMatchObject({ kind: "reward", state: "ended" });
    expect((await (await api(ann.token, "GET", "/timer")).json<{ timer: Timer | null }>()).timer).toBeNull();
  });

  it("«👁»: первый шаг текстом пишется в карточку, задача за кнопкой остается скрытой", async () => {
    const id = await insertTask("позвонить маме", { important: 1 });
    expect((await today()).buttons.important).toMatchObject({ itemId: id, hidden: true, firstStep: null });
    const saved = await api(ann.token, "PATCH", `/items/${id}`, { firstStepText: "найти номер" });
    expect(saved.status).toBe(200);
    expect((await today()).buttons.important).toMatchObject({ hidden: true, firstStep: "найти номер" });
  });
});

describe("награды и первый шаг в боте", () => {
  it("список с наградами и «Старт: награда»; таймер награды без «Парковки», после конца одна «Завершить»", async () => {
    await insertReward("почитать книгу", 5);
    await insertTask("позвонить маме", { important: 1 });
    await press(`b|${D}|important`);
    await press(`d|${D}|important|0|accept`);
    const list = sent("sendMessage").at(-1)!;
    expect(list.payload.text).toBe("Список на сегодня\n\n🏆 почитать книгу\n• позвонить маме\n🎁 Награда");
    expect(buttons(list)[0]).toEqual({ text: "Старт: почитать книгу", callback_data: `tr|${D}|0` });

    await press(`tr|${D}|0`, 1, String(list.payload.text));
    const shown = sent("sendMessage").at(-1)!;
    expect(shown.payload.text).toBe("⏱ почитать книгу, до 12:05");
    expect(buttons(shown).map((b) => b.text)).toEqual(["Пауза", "Стоп"]);

    later(5);
    const stub = env.TIMERS.get(env.TIMERS.idFromName(ann.id));
    await runInDurableObject(stub, (instance) => (instance as TimerAlarm).alarm());
    const ended = sent("sendMessage").at(-1)!;
    expect(ended.payload.text).toBe("⏰ Время вышло: почитать книгу");
    expect(buttons(ended).map((b) => b.text)).toEqual(["Завершить"]);
    await press("t|f", 1, String(ended.payload.text));
    expect(sent("editMessageText").at(-1)!.payload.text).toBe("⏹ Таймер остановлен: почитать книгу\n\n✓ Завершить");
  });

  it("после «Сделано» на месте задачи «🏆 Награда» показывает открытую награду со «Старт»", async () => {
    await insertReward("планка", 3);
    await insertTask("позвонить маме", { important: 1 });
    await press(`b|${D}|important`);
    await press(`d|${D}|important|0|accept`);
    await press(`d|${D}|important|0|done`);
    const card = sent("editMessageText").at(-1)!;
    expect(buttons(card).map((b) => b.text)).toEqual(["🏆 Награда", "🚀 Дофамин", "🔄 Обновить"]);
    await press(`rw|${D}`);
    const reward = sent("sendMessage").at(-1)!;
    expect(reward.payload.text).toBe("🏆 планка");
    expect(buttons(reward)).toEqual([{ text: "Старт", callback_data: `tr|${D}|1` }]);
  });

  it("без наград в «Справочниках» нет ни наград в списке, ни кнопки «Награда»", async () => {
    await insertTask("позвонить маме", { important: 1 });
    await press(`b|${D}|important`);
    await press(`d|${D}|important|0|accept`);
    await press(`d|${D}|important|0|done`);
    expect(buttons(sent("editMessageText").at(-1)!).map((b) => b.text)).toEqual(["🚀 Дофамин", "🔄 Обновить"]);
    expect(sent("sendMessage").at(-1)!.payload.text).toBe("Список на сегодня\n\n✓ позвонить маме");
  });

  it("«Принять» спрашивает голосовой первый шаг; голосовое ответом сохраняется, потом приходит после карточки и заменяется", async () => {
    const id = await insertTask("позвонить маме", { important: 1 });
    await press(`b|${D}|important`, 50);
    await press(`d|${D}|important|0|accept`, 50);
    const messages = sent("sendMessage").map((c) => String(c.payload.text));
    // вопрос о первом шаге приходит до списка: список остается последним
    expect(messages.at(-2)).toMatch(/^С чего начнешь\? Запиши голосовое/);
    expect(messages.at(-1)).toMatch(/^Список на сегодня/);

    // текст ответом на вопрос уходит в инбокс, вопрос остается
    await botMessage(1, { text: "найти номер" });
    const inbox = await env.DB.prepare("SELECT kind FROM items WHERE title = ?").bind("найти номер").first<{ kind: string }>();
    expect(inbox).toMatchObject({ kind: "inbox" });
    await voice("voice-1", 1);
    expect(await voiceOf(id)).toBe("voice-1");
    expect(sent("setMessageReaction").length).toBeGreaterThan(0);

    // при новом нажатии кнопки задачи бот присылает голосовое после карточки
    await press(`b|${D}|important`);
    const played = sent("sendVoice").at(-1)!;
    expect(played.payload).toMatchObject({ voice: "voice-1", caption: "Первый шаг: позвонить маме\nОтветь голосовым, чтобы заменить" });

    await voice("voice-2", 1);
    expect(await voiceOf(id)).toBe("voice-2");
    const view = await today();
    expect(view.buttons.important).toMatchObject({ hasVoice: true });
    expect(JSON.stringify(view)).not.toContain("voice-2");
  });

  it("голосовое не ответом на вопрос о первом шаге: подсказка, ничего не записывается", async () => {
    const id = await insertTask("позвонить маме", { important: 1 });
    await voice("voice-1");
    expect(sent("sendMessage").at(-1)!.payload.text).toBe(
      "Голосовое сохраняется только как первый шаг: ответь им на вопрос о первом шаге",
    );
    expect(await voiceOf(id)).toBeNull();
  });
});
