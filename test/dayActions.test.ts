import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createUser, resetDb } from "./helpers";

type Row = {
  slot: string;
  position: number;
  itemId: string;
  title: string;
  state: string;
  hidden: boolean;
  replacements: number;
  flavor: string | null;
  askBlocks: boolean;
  reasonPrompt: string | null;
};
type Today = { deadlines: Row[]; buttons: Record<string, Row | undefined>; picked: Row[]; done: number };

let ann: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(async () => {
  await resetDb();
  ann = await createUser(1001, "Ann");
  bob = await createUser(2002, "Bob");
});

async function insertTask(ownerId: string, title: string, fields: Record<string, string | number | null> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const columns = Object.keys(fields);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, kind, title, owner_id, creator_id, household_id, source, created_at, updated_at)
      SELECT ?, 'task', ?, ?, ?, household_id, 'web', 0, 0 FROM users WHERE id = ?`,
    ).bind(id, title, ownerId, ownerId, ownerId),
    env.DB.prepare(
      `INSERT INTO tasks (id${columns.map((c) => `, ${c}`).join("")}) VALUES (?${columns.map(() => ", ?").join("")})`,
    ).bind(id, ...Object.values(fields)),
  ]);
  return id;
}

async function today(token = ann.token): Promise<Today> {
  const response = await api(token, "GET", "/today");
  expect(response.status).toBe(200);
  return response.json<Today>();
}

async function act(slot: string, position: number, action: string, body?: unknown, token = ann.token) {
  const response = await api(token, "POST", `/today/${slot}/${position}/${action}`, body);
  return { status: response.status, today: response.status === 200 ? await response.json<Today>() : undefined };
}

const taskRow = (id: string) =>
  env.DB.prepare("SELECT last_shown_at, skip_count, refusal_note FROM tasks WHERE id = ?")
    .bind(id)
    .first<{ last_shown_at: number | null; skip_count: number; refusal_note: string | null }>();

describe("кнопки плана дня: принять и сделано", () => {
  it("задача за кнопкой скрыта, пока ее не нажали; показ пишет время показа", async () => {
    const id = await insertTask(ann.id, "позвонить", { important: 1, why: "нужно" });
    const plan = await today();
    expect(plan.buttons.important).toMatchObject({ itemId: id, state: "offered", hidden: true });
    expect((await taskRow(id))?.last_shown_at).toBeNull();

    const shown = await act("important", 0, "reveal");
    expect(shown.today?.buttons.important?.hidden).toBe(false);
    expect((await taskRow(id))?.last_shown_at).not.toBeNull();
    expect((await act("important", 0, "reveal")).status).toBe(400);
  });

  it("принять, сделано: задача уходит в архив, кольцо растет, строка остается выполненной", async () => {
    const id = await insertTask(ann.id, "позвонить", { important: 1, why: "нужно" });
    await today();
    expect((await act("important", 0, "accept")).status).toBe(400);
    await act("important", 0, "reveal");
    expect((await act("important", 0, "done")).status).toBe(400);
    expect((await act("important", 0, "accept")).today?.buttons.important?.state).toBe("accepted");

    const done = await act("important", 0, "done");
    expect(done.today).toMatchObject({ done: 1, buttons: { important: { state: "done" } } });
    const item = await env.DB.prepare("SELECT archived_at, archive_reason FROM items WHERE id = ?")
      .bind(id)
      .first<{ archived_at: number | null; archive_reason: string }>();
    expect(item?.archived_at).not.toBeNull();
    expect(item?.archive_reason).toBe("done");
    expect((await act("important", 0, "done")).status).toBe(400);
  });

  it("чужой план не изменить: действия идут по плану вошедшего", async () => {
    await insertTask(ann.id, "задача Ann", { important: 1, why: "x" });
    await today();
    expect((await act("important", 0, "reveal", undefined, bob.token)).status).toBe(404);
  });

  it("неверные слот, позиция и действие отвергаются", async () => {
    await insertTask(ann.id, "задача", { important: 1, why: "x" });
    await today();
    expect((await act("nothing", 0, "reveal")).status).toBe(400);
    expect((await act("important", -1, "reveal")).status).toBe(400);
    expect((await act("important", 0, "explode")).status).toBe(400);
    expect((await act("important", 5, "reveal")).status).toBe(404);
  });
});

describe("кнопки плана дня: отказ и замена", () => {
  it("отказ: причина в карточку, «Что мешает?» в инсайты, счетчик отказов, замена той же отметки", async () => {
    for (let i = 0; i < 5; i++) await insertTask(ann.id, `задача ${i}`, { important: 1, why: "нужно" });
    const first = (await today()).buttons.important!;
    await act("important", 0, "reveal");

    const refused = await act("important", 0, "refuse");
    expect(refused.today?.buttons.important).toMatchObject({ state: "refused", askBlocks: true });
    expect(refused.today?.buttons.important?.reasonPrompt).not.toBeNull();
    expect((await act("important", 0, "reason", { text: "  " })).status).toBe(400);
    await act("important", 0, "reason", { text: "не хватает сил" });
    expect((await taskRow(first.itemId))?.refusal_note).toBe("не хватает сил");

    const next = await act("important", 0, "next", { blocks: "усталость" });
    expect(next.today?.buttons.important).toMatchObject({ position: 1, state: "offered", hidden: false, replacements: 1 });
    expect(next.today?.buttons.important?.itemId).not.toBe(first.itemId);
    expect((await taskRow(first.itemId))?.skip_count).toBe(1);
    const insights = await env.DB.prepare("SELECT text FROM insights WHERE user_id = ?").bind(ann.id).all<{ text: string }>();
    expect(insights.results.map((row) => row.text)).toEqual(["усталость"]);
    expect((await act("important", 0, "next")).status).toBe(400);
  });

  it("если подходящих задач больше нет, слот закрывается; ответ можно пропустить", async () => {
    for (let i = 0; i < 4; i++) await insertTask(ann.id, `задача ${i}`, { important: 1, why: "нужно" });
    await today();
    await act("important", 0, "reveal");
    await act("important", 0, "refuse");
    const closed = await act("important", 0, "next", { blocks: "" });
    expect(closed.today?.buttons.important).toMatchObject({ position: 0, state: "closed" });
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM insights").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("«все же взять» принимает задачу после отказа без счета отказа", async () => {
    const id = await insertTask(ann.id, "задача", { important: 1, why: "нужно" });
    await today();
    await act("important", 0, "reveal");
    await act("important", 0, "refuse");
    expect((await act("important", 0, "accept")).today?.buttons.important?.state).toBe("accepted");
    expect((await taskRow(id))?.skip_count).toBe(0);
  });

  it("не больше двух замен на кнопку в день", async () => {
    for (let i = 0; i < 8; i++) await insertTask(ann.id, `задача ${i}`, { important: 1, why: "нужно" });
    await today();
    await act("important", 0, "reveal");
    await act("important", 0, "refuse");
    await act("important", 0, "next");
    await act("important", 1, "refuse");
    await act("important", 1, "next");
    await act("important", 2, "refuse");
    const last = await act("important", 2, "next");
    expect(last.today?.buttons.important).toMatchObject({ position: 2, state: "closed" });
  });
});

describe("кнопки плана дня: «Обновить» и «Дофамин»", () => {
  it("после «Сделано» «Обновить» дает новую задачу, «Дофамин» — дофаминовую; пропустить и закрыть без счета отказа", async () => {
    for (let i = 0; i < 6; i++) await insertTask(ann.id, `дело ${i}`, { important: 1, why: "x" });
    const fun = await insertTask(ann.id, "поболтать с Клодом", { flavor: "dopamine" });
    await today();
    await act("important", 0, "reveal");
    await act("important", 0, "accept");
    await act("important", 0, "done");

    const dopamine = await act("important", 0, "dopamine");
    expect(dopamine.today?.buttons.important).toMatchObject({ itemId: fun, position: 1, state: "offered", flavor: "dopamine" });
    expect((await act("important", 1, "refuse")).status).toBe(400);
    const released = await act("important", 1, "release");
    expect(released.today?.buttons.important?.state).toBe("closed");
    expect((await taskRow(fun))?.skip_count).toBe(0);
    expect((await api(ann.token, "POST", "/today/pick", { itemId: fun })).status).toBe(400);
    expect((await act("important", 1, "dopamine")).status).toBe(409);

    const refresh = await act("important", 1, "refresh");
    expect(refresh.today?.buttons.important).toMatchObject({ position: 2, state: "offered", hidden: false });
    expect(refresh.today?.buttons.important?.flavor).toBeNull();
  });

  it("взятая дофаминовая задача принимается и закрывается без архива", async () => {
    for (let i = 0; i < 2; i++) await insertTask(ann.id, `дело ${i}`, { important: 1, why: "x" });
    const fun = await insertTask(ann.id, "вечная", { flavor: "dopamine" });
    await today();
    await act("important", 0, "reveal");
    await act("important", 0, "accept");
    await act("important", 0, "done");
    await act("important", 0, "dopamine");
    await act("important", 1, "accept");
    const closed = await act("important", 1, "release");
    expect(closed.today?.buttons.important?.state).toBe("closed");
    const item = await env.DB.prepare("SELECT archived_at FROM items WHERE id = ?").bind(fun).first<{ archived_at: number | null }>();
    expect(item?.archived_at).toBeNull();
    expect(closed.today?.done).toBe(1);
  });

  it("«Обновить» и «Дофамин» есть только после выполненной задачи; без подходящих задач — 409", async () => {
    await insertTask(ann.id, "единственная", { important: 1, why: "x" });
    await today();
    await act("important", 0, "reveal");
    expect((await act("important", 0, "refresh")).status).toBe(400);
    await act("important", 0, "accept");
    await act("important", 0, "done");
    expect((await act("important", 0, "refresh")).status).toBe(409);
    expect((await act("important", 0, "dopamine")).status).toBe(409);
  });
});

describe("«Выбрать» и дедлайны", () => {
  it("выбранная задача сразу принята и один раз за день; чужую выбрать нельзя", async () => {
    const mine = await insertTask(ann.id, "моя", { important: 1, why: "x" });
    const other = await insertTask(bob.id, "чужая", { important: 1, why: "x" });
    await insertTask(ann.id, "для выбора", { easy: 1 });
    await today();
    const chosen = (await insertTask(ann.id, "выбранная", {})) as string;

    const response = await api(ann.token, "POST", "/today/pick", { itemId: chosen });
    expect(response.status).toBe(200);
    const plan = await response.json<Today>();
    expect(plan.picked).toMatchObject([{ itemId: chosen, state: "accepted", position: 0 }]);
    expect((await api(ann.token, "POST", "/today/pick", { itemId: chosen })).status).toBe(400);
    expect((await api(ann.token, "POST", "/today/pick", { itemId: other })).status).toBe(404);
    expect((await api(ann.token, "POST", "/today/pick", { itemId: "" })).status).toBe(400);
    expect((await api(ann.token, "POST", "/today/pick", {})).status).toBe(400);

    // задачу, от которой сегодня отказались, второй раз взять нельзя
    const firstButton = (await today()).buttons.important;
    await act("important", 0, "reveal");
    expect((await act("important", 0, "refuse")).status).toBe(200);
    expect((await api(ann.token, "POST", "/today/pick", { itemId: firstButton!.itemId })).status).toBe(400);

    const done = await act("picked", 0, "done");
    expect(done.today).toMatchObject({ done: 1, picked: [{ state: "done" }] });
    expect(mine).toBeDefined();
  });

  it("при пустом плане «Выбрать» работает: план составляется без выбранной задачи", async () => {
    expect(await today()).toMatchObject({ deadlines: [], picked: [] });
    const chosen = await insertTask(ann.id, "выбранная", { important: 1, why: "x" });
    const other = await insertTask(ann.id, "другая", { important: 1, why: "x" });
    const response = await api(ann.token, "POST", "/today/pick", { itemId: chosen });
    expect(response.status).toBe(200);
    const plan = await response.json<Today>();
    expect(plan.picked).toMatchObject([{ itemId: chosen, state: "accepted" }]);
    expect(plan.buttons.important?.itemId).toBe(other);
  });

  it("единственную задачу «можно сейчас» при пустом плане можно взять через «Выбрать»", async () => {
    expect(await today()).toMatchObject({ deadlines: [], picked: [] });
    const only = await insertTask(ann.id, "единственная", { important: 1, why: "x" });
    const response = await api(ann.token, "POST", "/today/pick", { itemId: only });
    expect(response.status).toBe(200);
    const plan = await response.json<Today>();
    expect(plan.picked).toMatchObject([{ itemId: only, state: "accepted" }]);
    expect(plan.buttons).toEqual({});
  });

  it("задача блока дедлайнов отмечается «Сделано» без принятия", async () => {
    const id = await insertTask(ann.id, "сдать отчет", { deadline: Date.now() + 86_400_000, queued: 1 });
    const plan = await today();
    expect(plan.deadlines).toMatchObject([{ itemId: id, state: "offered" }]);
    expect((await act("deadline", 0, "refuse")).status).toBe(400);
    const done = await act("deadline", 0, "done");
    expect(done.today?.deadlines[0].state).toBe("done");
    expect(done.today?.done).toBe(0);
    const item = await env.DB.prepare("SELECT archived_at FROM items WHERE id = ?").bind(id).first<{ archived_at: number | null }>();
    expect(item?.archived_at).not.toBeNull();
  });
});
