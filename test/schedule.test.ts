import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { day } from "../src/core/day";
import { dueEvents, sameTimeTomorrow, schedule, startOfLocalDay } from "../src/core/schedule";
import { createDb } from "../src/db/client";
import { createUser, resetDb } from "./helpers";

const db = () => createDb(env.DB);
const D = "2026-11-10";
const NEXT = "2026-11-11";
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00Z`);
const none = { surveyOn: null, morningOn: null, deadlineOn: null, nightOn: null };

describe("время событий дня", () => {
  it("событие наступает со своего времени по поясу пользователя и один раз за дату", () => {
    expect(dueEvents(none, "Europe/Dublin", at(D, "02:59"))).toEqual([]);
    expect(dueEvents(none, "Europe/Dublin", at(D, "09:00"))).toEqual(["night", "morning"]);
    expect(dueEvents(none, "Europe/Dublin", at(D, "21:00"))).toEqual(["night", "morning", "deadline", "survey"]);
    const marked = { surveyOn: D, morningOn: D, deadlineOn: D, nightOn: D };
    expect(dueEvents(marked, "Europe/Dublin", at(D, "23:00"))).toEqual([]);
    expect(dueEvents(marked, "Europe/Dublin", at(NEXT, "03:00"))).toEqual(["night"]);
  });

  it("летнее время: в день перехода опрос в 21:00 по местному времени (20:00 UTC)", () => {
    expect(dueEvents({ ...none, nightOn: "2026-03-29", morningOn: "2026-03-29", deadlineOn: "2026-03-29" }, "Europe/Dublin", Date.parse("2026-03-29T19:59:00Z"))).toEqual([]);
    expect(dueEvents({ ...none, nightOn: "2026-03-29", morningOn: "2026-03-29", deadlineOn: "2026-03-29" }, "Europe/Dublin", Date.parse("2026-03-29T20:00:00Z"))).toEqual(["survey"]);
    expect(startOfLocalDay("2026-03-30", "Europe/Dublin")).toBe(Date.parse("2026-03-29T23:00:00Z"));
    expect(startOfLocalDay("2026-10-26", "Europe/Dublin")).toBe(Date.parse("2026-10-26T00:00:00Z"));
  });

  it("«Напомнить снова завтра» — то же местное время на следующий день, через переход на летнее и зимнее время", () => {
    const original = Date.parse("2026-03-28T09:00:00Z");
    expect(sameTimeTomorrow(original, original, "Europe/Dublin")).toBe(Date.parse("2026-03-29T08:00:00Z"));
    const autumn = Date.parse("2026-10-24T08:00:00Z");
    expect(sameTimeTomorrow(autumn, Date.parse("2026-10-24T20:00:00Z"), "Europe/Dublin")).toBe(Date.parse("2026-10-25T09:00:00Z"));
  });
});

let ann: { id: string; timezone: string; language: string };

beforeEach(async () => {
  await resetDb();
  ann = { id: (await createUser(1001, "Ann")).id, timezone: "Europe/Dublin", language: "ru" };
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

const accept = (itemId: string, date: string) =>
  env.DB.prepare(
    "INSERT INTO day_plan (user_id, date, slot, position, item_id, state, hidden, created_at) VALUES (?, ?, 'picked', 0, ?, 'accepted', 0, 0)",
  )
    .bind(ann.id, date, itemId)
    .run();

/** Все события до `D` уже выполнены: проверяется только нужное. */
const markAll = (date: string) =>
  env.DB.prepare("UPDATE users SET survey_on = ?, morning_on = ?, deadline_on = ?, night_on = ?, reprompt_on = ?")
    .bind(date, date, date, date, date)
    .run();

describe("запуск расписания", () => {
  it("вечерний опрос отправляется один раз, только если есть принятые несделанные задачи", async () => {
    await markAll(D);
    await env.DB.prepare("UPDATE users SET survey_on = NULL").run();
    expect((await schedule.tick(db(), at(D, "21:00"))).users).toEqual([]);

    await env.DB.prepare("UPDATE users SET survey_on = NULL").run();
    await accept(await insertTask("задача"), D);
    const first = await schedule.tick(db(), at(D, "21:00"));
    expect(first.users[0].survey?.survey).toHaveLength(1);
    expect((await schedule.tick(db(), at(D, "21:05"))).users).toEqual([]);
  });

  it("утро: если вчерашний опрос не пройден — сначала он (один раз), после опроса — пять кнопок", async () => {
    await markAll(D);
    await accept(await insertTask("вчерашняя"), D);
    for (let i = 0; i < 4; i++) await insertTask(`задача ${i}`, { important: 1, why: "x" });

    const morning = await schedule.tick(db(), at(NEXT, "09:00"));
    const tick = morning.users.find((user) => user.morning);
    expect(tick?.morning).toMatchObject({ reprompt: true, view: { locked: true } });
    expect((await schedule.tick(db(), at(NEXT, "09:05"))).users.some((user) => user.morning)).toBe(false);

    await day.survey(db(), ann, at(NEXT, "09:07"), { date: D, slot: "picked", position: 0, answer: "back" }, undefined);
    const after = await schedule.tick(db(), at(NEXT, "09:10"));
    expect(after.users.find((user) => user.morning)?.morning).toMatchObject({ reprompt: false, view: { locked: false } });
    expect(Object.keys(after.users[0].morning!.view.buttons)).toHaveLength(4);
    expect((await schedule.tick(db(), at(NEXT, "09:15"))).users).toEqual([]);
  });

  it("утро без опроса: пять кнопок с времени утра", async () => {
    await markAll(D);
    for (let i = 0; i < 4; i++) await insertTask(`задача ${i}`, { important: 1, urgent: 1, impactful: 1, easy: 1, why: "x" });
    expect((await schedule.tick(db(), at(NEXT, "08:55"))).users.some((user) => user.morning)).toBe(false);
    const morning = (await schedule.tick(db(), at(NEXT, "09:00"))).users[0].morning;
    expect(morning?.reprompt).toBe(false);
    expect(Object.keys(morning!.view.buttons).sort()).toEqual(["easy", "impactful", "important", "urgent"]);
  });

  it("первый запуск после 21:00 при непройденном вчерашнем опросе присылает опрос один раз", async () => {
    await markAll(D);
    await accept(await insertTask("вчерашняя"), D);
    const tick = (await schedule.tick(db(), at(NEXT, "21:05"))).users[0];
    expect(tick.morning?.reprompt).toBe(true);
    expect(tick.survey).toBeUndefined();
  });

  it("неудачная отправка возвращает отметку события и напоминание: следующий запуск отправляет снова", async () => {
    await markAll(D);
    const id = await insertTask("позвонить", { remind_at: at(NEXT, "09:00") });
    const first = await schedule.tick(db(), at(NEXT, "09:00"));
    const tick = first.users[0];
    expect(tick.claims.morning).toEqual({ column: "morning_on", date: NEXT, previous: D });
    expect(first.reminders).toHaveLength(1);
    expect((await schedule.tick(db(), at(NEXT, "09:05"))).users).toEqual([]);

    await schedule.release(db(), ann.id, tick.claims.morning!);
    await schedule.restoreReminder(db(), id, at(NEXT, "09:00"));
    const again = await schedule.tick(db(), at(NEXT, "09:10"));
    expect(again.users[0].morning?.reprompt).toBe(false);
    expect(again.reminders).toMatchObject([{ itemId: id }]);
  });

  it("накануне дедлайна — названия задач с дедлайном завтра", async () => {
    await markAll(D);
    await env.DB.prepare("UPDATE users SET deadline_on = NULL").run();
    await insertTask("сдать отчет", { deadline: at(NEXT, "18:00") });
    await insertTask("послезавтра", { deadline: at("2026-11-12", "00:30") });
    const tick = await schedule.tick(db(), at(D, "10:00"));
    expect(tick.users[0].deadlines).toEqual(["сдать отчет"]);
  });

  it("напоминание отправляется один раз и снимается; архивное снимается без отправки", async () => {
    await markAll(D);
    const id = await insertTask("позвонить", { remind_at: at(D, "11:00") });
    const archived = await insertTask("старое", { remind_at: at(D, "10:00") });
    await env.DB.prepare("UPDATE items SET archived_at = 1 WHERE id = ?").bind(archived).run();
    expect((await schedule.tick(db(), at(D, "10:58"))).reminders).toEqual([]);

    const tick = await schedule.tick(db(), at(D, "11:00"));
    expect(tick.reminders).toMatchObject([{ itemId: id, title: "позвонить", remindAt: at(D, "11:00") }]);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM tasks WHERE remind_at IS NOT NULL").first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await schedule.tick(db(), at(D, "11:05"))).reminders).toEqual([]);

    expect(await schedule.remindTomorrow(db(), ann, id, at(D, "11:00"), at(D, "11:01"))).toBe(true);
    const again = await env.DB.prepare("SELECT remind_at FROM tasks WHERE id = ?").bind(id).first<{ remind_at: number }>();
    expect(again?.remind_at).toBe(at(NEXT, "11:00"));
  });

  it("ночью удаляются планы старше срока, снимаются истекшие «отложено до» и старые вопросы бота", async () => {
    await markAll(D);
    const old = await insertTask("старая");
    const deferred = await insertTask("отложенная", { deferred: 1, deferred_until: at(D, "01:00") });
    const later = await insertTask("позже", { deferred: 1, deferred_until: at("2026-12-01", "01:00") });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO day_plan (user_id, date, slot, position, item_id, state, created_at) VALUES (?, '2026-10-01', 'picked', 0, ?, 'done', 0)").bind(ann.id, old),
      env.DB.prepare("INSERT INTO day_plan (user_id, date, slot, position, item_id, state, created_at) VALUES (?, '2026-10-20', 'picked', 0, ?, 'done', 0)").bind(ann.id, old),
      env.DB.prepare("INSERT INTO bot_prompts (user_id, message_id, card_message_id, kind, date, slot, position, created_at) VALUES (?, 5, 4, 'blocks', ?, 'important', 0, ?)").bind(ann.id, D, at("2026-11-09", "01:00")),
    ]);
    const night = await schedule.tick(db(), at(NEXT, "03:00"));
    // сообщение удаленного вопроса убирается и из чата
    expect(night.users[0].staleMessages).toEqual([5]);
    const plans = await env.DB.prepare("SELECT date FROM day_plan").all<{ date: string }>();
    expect(plans.results.map((row) => row.date)).toEqual(["2026-10-20"]);
    const flags = await env.DB.prepare("SELECT id, deferred FROM tasks WHERE id IN (?, ?)").bind(deferred, later).all<{ id: string; deferred: number }>();
    expect(Object.fromEntries(flags.results.map((row) => [row.id, row.deferred]))).toEqual({ [deferred]: 0, [later]: 1 });
    const prompts = await env.DB.prepare("SELECT count(*) AS n FROM bot_prompts").first<{ n: number }>();
    expect(prompts?.n).toBe(0);
  });
});
