import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerAlarm } from "../src/jobs/timerAlarm";
import { api, call, createUser, mockTelegram, resetDb, type TelegramCall } from "./helpers";

// не менять: настоящий будильник Durable Object сработал бы во время теста
const NOW = "2054-11-10T12:00:00Z";
const D = "2054-11-10";
const from = { id: 1001, first_name: "Ann", language_code: "ru" };
let updateId = 7000;
let calls: TelegramCall[];
let ann: { id: string; token: string };

type Timer = { itemId: string; title: string; state: string; endsAt: number | null; remainingSec: number | null; startedIn: string; botMessageId: number | null };
type Row = { slot: string; position: number; itemId: string; state: string };
type Today = { buttons: Record<string, Row | undefined>; picked: Row[]; timer?: Timer | null };

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

async function post(path: string, body: unknown = {}) {
  const response = await api(ann.token, "POST", path, body);
  return { status: response.status, body: await response.json<{ timer: Timer | null; today?: Today; error?: string }>() };
}

async function today(): Promise<Today> {
  return (await api(ann.token, "GET", "/today")).json<Today>();
}

/** Задача «Важная» принята. */
async function accepted(title = "позвонить маме"): Promise<string> {
  const id = await insertTask(title, { important: 1, why: "давно не звонила" });
  await today();
  await post("/today/important/0/reveal");
  await post("/today/important/0/accept");
  return id;
}

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

const reply = (text: string, replyTo: number) =>
  webhook({
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

const sent = (method: string) => calls.filter((c) => c.method === method);
const buttons = (c: TelegramCall) =>
  ((c.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })?.inline_keyboard ?? []).flat();

const planState = (itemId: string) =>
  env.DB.prepare("SELECT state FROM day_plan WHERE item_id = ? AND date = ?").bind(itemId, D).first<{ state: string }>();

describe("таймер на странице", () => {
  it("запуск у принятой задачи, один таймер на пользователя, пауза и продолжение с того же остатка", async () => {
    const id = await accepted();
    await insertTask("купить хлеб", { urgent: 1 });

    expect((await post("/timer/start/important/0/7")).status).toBe(400);
    expect((await post("/timer/start/urgent/0/10")).status).toBe(404);
    const started = await post("/timer/start/important/0/10");
    expect(started.status).toBe(200);
    expect(started.body.timer).toMatchObject({ itemId: id, state: "running", startedIn: "web", endsAt: Date.parse(NOW) + 600_000 });
    expect((await today()).timer).toMatchObject({ itemId: id, state: "running" });

    // второй таймер не запускается, пока идет первый
    expect((await post("/timer/start/important/0/5")).status).toBe(409);

    later(4);
    const paused = await post("/timer/pause");
    expect(paused.body.timer).toMatchObject({ state: "paused", remainingSec: 360, endsAt: null });
    later(30);
    const resumed = await post("/timer/resume");
    expect(resumed.body.timer).toMatchObject({ state: "running", endsAt: Date.parse(NOW) + 30 * 60_000 + 360_000 });

    const stopped = await post("/timer/stop");
    expect(stopped.body.timer?.state).toBe("ended");
    expect((await post("/timer/pause")).status).toBe(400);
  });

  it("«Завершить» = «Сделано»: задача выполнена, таймер снят", async () => {
    const id = await accepted();
    await post("/timer/start/important/0/5");
    await post("/timer/stop");
    const finished = await post("/timer/finish");
    expect(finished.status).toBe(200);
    expect(finished.body.today?.buttons.important?.state).toBe("done");
    expect((await planState(id))?.state).toBe("done");
    expect((await today()).timer).toBeNull();
  });

  it("«Продолжить» после окончания — новый таймер той же задачи; «Продолжить позже» оставляет задачу принятой", async () => {
    const id = await accepted();
    await post("/timer/start/important/0/5");
    later(6);
    // время вышло, будильник еще не сработал: «Продолжить» уже доступно
    const again = await post("/timer/again/15");
    expect(again.body.timer).toMatchObject({ itemId: id, state: "running", endsAt: Date.parse(NOW) + 21 * 60_000 });
    await post("/timer/stop");
    expect((await post("/timer/later")).status).toBe(200);
    expect((await today()).timer).toBeNull();
    expect((await planState(id))?.state).toBe("accepted");
  });

  it("«Вернуть»: задача в хранилище как неудача, «Что мешает?» сохраняется в инсайты", async () => {
    const id = await accepted();
    await post("/timer/start/important/0/5");
    await post("/timer/stop");
    const back = await post("/timer/back", { blocks: "нет сил" });
    expect(back.status).toBe(200);
    expect((await planState(id))?.state).toBe("returned");
    const task = await env.DB.prepare("SELECT skip_count FROM tasks WHERE id = ?").bind(id).first<{ skip_count: number }>();
    expect(task?.skip_count).toBe(1);
    const insight = await env.DB.prepare("SELECT text FROM insights").first<{ text: string }>();
    expect(insight?.text).toBe("нет сил");
    expect((await today()).timer).toBeNull();
  });

  it("«Сделано» у задачи снимает ее таймер", async () => {
    await accepted();
    await post("/timer/start/important/0/5");
    await post("/today/important/0/done");
    expect((await today()).timer).toBeNull();
  });

  it("«Парковка»: мысль уходит в инбокс", async () => {
    expect((await post("/timer/park", { text: " " })).status).toBe(400);
    expect((await post("/timer/park", { text: "записаться к врачу" })).status).toBe(200);
    const item = await env.DB.prepare("SELECT title, source FROM items WHERE owner_id = ?").bind(ann.id).first();
    expect(item).toMatchObject({ title: "записаться к врачу", source: "web" });
  });
  it("«Пауза» после окончания времени не принимается, даже если будильник еще не сработал", async () => {
    await accepted();
    expect((await post("/timer/start/important/0/5")).status).toBe(200);
    later(6);
    expect((await post("/timer/pause")).status).toBe(400);
  });

  it("«Вернуть» у дедлайна: дедлайн уходит из блока дедлайнов", async () => {
    const id = await insertTask("сдать отчет", { deadline: Date.parse(NOW) + 86_400_000 });
    expect((await today() as Today & { deadlines: Row[] }).deadlines).toMatchObject([{ itemId: id, state: "offered" }]);
    await post("/timer/start/deadline/0/5");
    await post("/timer/stop");
    expect((await post("/timer/back")).status).toBe(200);
    expect((await today() as Today & { deadlines: Row[] }).deadlines).toEqual([]);
  });
});

describe("таймер в боте", () => {
  it("«Таймер» в боте, пока идет таймер со страницы: «Уже идет таймер» без кнопок таймера", async () => {
    await accepted();
    await post("/timer/start/important/0/10");
    await press(`ts|${D}|important|0|5`, 70);
    const busy = sent("sendMessage").at(-1)!;
    expect(busy.payload.text).toBe("Уже идет таймер: позвонить маме");
    expect(buttons(busy)).toEqual([]);
    expect((await today()).timer?.botMessageId).toBeNull();
  });

  it("«Время вышло» не отправилось: таймер в базе не меняется, повтор будильника отправляет сообщение", async () => {
    await accepted();
    await press(`ts|${D}|important|0|5`, 60);
    later(5);
    const stub = env.TIMERS.get(env.TIMERS.idFromName(ann.id));
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => Response.json({ ok: false, error_code: 500, description: "x" }, { status: 500 }));
    await expect(runInDurableObject(stub, (instance) => (instance as TimerAlarm).alarm())).rejects.toThrow();
    // время вышло: таймер показывается остановленным, хотя будильник еще не сработал
    expect((await today()).timer).toMatchObject({ state: "ended", endsAt: Date.parse(NOW) + 5 * 60_000 });
    await runInDurableObject(stub, (instance) => (instance as TimerAlarm).alarm());
    expect(sent("sendMessage").at(-1)!.payload.text).toBe("⏰ Время вышло: позвонить маме");
    expect((await today()).timer).toMatchObject({ state: "ended", endsAt: null, botMessageId: 1 });
  });

  it("таймер изменили, пока будильник отправлял «Время вышло»: таймер не меняется, новое сообщение удаляется", async () => {
    await accepted();
    await press(`ts|${D}|important|0|5`, 60);
    later(5);
    const stub = env.TIMERS.get(env.TIMERS.idFromName(ann.id));
    const send = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
      // пока сообщение отправляется, таймер той же задачи запускают заново
      await env.DB.prepare("UPDATE timers SET ends_at = ends_at + 60000 WHERE user_id = ?").bind(ann.id).run();
      return send(input, init);
    });
    await runInDurableObject(stub, (instance) => (instance as TimerAlarm).alarm());
    expect(sent("deleteMessage").at(-1)!.payload.message_id).toBe(1);
    expect((await today()).timer).toMatchObject({ state: "running", botMessageId: 60 });
  });

  it("«Таймер» → длина → сообщение «⏱ до»; будильник присылает «Время вышло» с четырьмя кнопками", async () => {
    await accepted();
    await press(`tm|${D}|important|0`);
    const choice = sent("sendMessage").at(-1)!;
    expect(choice.payload.text).toBe("позвонить маме");
    expect(buttons(choice).map((b) => b.text)).toEqual(["5 мин", "10 мин", "15 мин", "25 мин"]);

    await press(`ts|${D}|important|0|10`, 60, "позвонить маме");
    const shown = sent("editMessageText").at(-1)!;
    expect(shown.payload.message_id).toBe(60);
    expect(shown.payload.text).toBe("⏱ позвонить маме, до 12:10");
    expect(buttons(shown).map((b) => b.text)).toEqual(["Пауза", "Стоп", "Парковка"]);

    // кнопка с чужого сообщения устарела
    await press("t|p", 61, "x");
    expect(sent("editMessageText").at(-1)!.payload.text).toContain("Это уже изменилось");

    later(10);
    const stub = env.TIMERS.get(env.TIMERS.idFromName(ann.id));
    await runInDurableObject(stub, (instance) => (instance as TimerAlarm).alarm());
    expect(sent("deleteMessage").at(-1)!.payload.message_id).toBe(60);
    const ended = sent("sendMessage").at(-1)!;
    expect(ended.payload.text).toBe("⏰ Время вышло: позвонить маме");
    expect(buttons(ended).map((b) => b.text)).toEqual(["Завершить", "Продолжить", "Продолжить позже", "Вернуть"]);

    // новое сообщение (mock: message_id 1) — сообщение таймера; «Завершить» = «Сделано» и список заново
    await press("t|f", 1, "⏰ Время вышло: позвонить маме");
    expect(sent("editMessageText").at(-1)!.payload.text).toBe("⏹ Таймер остановлен: позвонить маме\n\n✓ Завершить");
    expect(sent("sendMessage").at(-1)!.payload.text).toMatch(/^Список на сегодня/);
  });

  it("пауза показывает остаток минут; таймер на странице не дает запустить второй в боте", async () => {
    await accepted();
    await press(`ts|${D}|important|0|25`, 60);
    later(1);
    await press("t|p", 60);
    expect(sent("editMessageText").at(-1)!.payload.text).toBe("⏸ позвонить маме, осталось 24 минуты");
    await press(`ts|${D}|important|0|5`, 70);
    // сообщение с длинами и прежнее сообщение таймера удаляются
    expect(sent("deleteMessage").map((c) => c.payload.message_id)).toEqual([70, 60]);
    expect(sent("sendMessage").at(-1)!.payload.text).toMatch(/^Уже идет таймер: позвонить маме/);
  });

  it("«Парковка» в боте: ответ на вопрос уходит в инбокс с 👍", async () => {
    await accepted();
    await press(`ts|${D}|important|0|10`, 60);
    await press("t|k", 60);
    const prompt = sent("sendMessage").at(-1)!;
    expect(String(prompt.payload.text)).toMatch(/^Какая мысль\?/);
    await reply("купить батарейки", 1);
    expect(sent("setMessageReaction").length).toBeGreaterThan(0);
    const item = await env.DB.prepare("SELECT source FROM items WHERE title = ?").bind("купить батарейки").first();
    expect(item).toMatchObject({ source: "bot" });
  });

  it("«Вернуть» в боте спрашивает «Что мешает?», ответ возвращает задачу в хранилище", async () => {
    const id = await accepted();
    await press(`ts|${D}|important|0|5`, 60);
    await press("t|x", 60);
    await press("t|b", 60, "⏹ Таймер остановлен: позвонить маме");
    expect(sent("editMessageText").at(-1)!.payload.text).toContain("Что мешает?");
    await reply("страшно", 1);
    expect((await planState(id))?.state).toBe("returned");
  });
});
