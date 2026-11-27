import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addDays,
  composePlan,
  localDate,
  pauseReason,
  priority,
  priorityLevel,
  taskStatus,
  type Candidate,
} from "../src/core/day";
import { api, createUser, resetDb } from "./helpers";

const tz = "Europe/Dublin";
const DAY = 86_400_000;

function candidate(id: string, fields: Partial<Candidate> = {}): Candidate {
  return {
    id,
    important: false,
    urgent: false,
    impactful: false,
    easy: false,
    flavor: null,
    deadline: null,
    lastShownAt: null,
    pause: null,
    ...fields,
  };
}

describe("приоритет", () => {
  it("важность и эффект по 2 балла, срочность и легкость по 1, пустая метка — «нет»", () => {
    expect(priority({ important: true, urgent: true, impactful: false, easy: false })).toBe(3);
    expect(priority({ important: null, urgent: null, impactful: null, easy: true })).toBe(1);
    expect(priority({ important: true, urgent: true, impactful: true, easy: true })).toBe(6);
  });

  it("уровни: главный 5–6, высокий 4, средний 2–3, низкий 1, нет 0", () => {
    expect([6, 5, 4, 3, 2, 1, 0].map(priorityLevel)).toEqual(["top", "top", "high", "medium", "medium", "low", "none"]);
  });
});

describe("дата пользователя по часовому поясу", () => {
  it("день меняется в полночь по Дублину, в том числе в дни перехода на летнее и зимнее время", () => {
    expect(localDate(Date.UTC(2026, 2, 28, 23, 30), tz)).toBe("2026-03-28");
    expect(localDate(Date.UTC(2026, 2, 29, 0, 30), tz)).toBe("2026-03-29");
    expect(localDate(Date.UTC(2026, 2, 29, 22, 59), tz)).toBe("2026-03-29");
    expect(localDate(Date.UTC(2026, 2, 29, 23, 0), tz)).toBe("2026-03-30");
    expect(localDate(Date.UTC(2026, 9, 24, 22, 59), tz)).toBe("2026-10-24");
    expect(localDate(Date.UTC(2026, 9, 24, 23, 0), tz)).toBe("2026-10-25");
    expect(localDate(Date.UTC(2026, 9, 25, 23, 30), tz)).toBe("2026-10-25");
    expect(localDate(Date.UTC(2026, 9, 26, 0, 0), tz)).toBe("2026-10-26");
  });

  it("сдвиг даты через границу месяца и года", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2028-02-25", 7)).toBe("2028-03-03");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
  });
});

describe("статус задачи", () => {
  const now = Date.UTC(2026, 10, 27, 12);
  const free = { deferred: false, deferredUntil: null, queued: false, waitingFor: null };

  it("пауза: отложено без даты или до будущей даты, очередь, жду", () => {
    expect(taskStatus(free, now)).toBe("now");
    expect(taskStatus({ ...free, deferred: true }, now)).toBe("paused");
    expect(taskStatus({ ...free, deferred: true, deferredUntil: now + 1 }, now)).toBe("paused");
    expect(taskStatus({ ...free, deferred: true, deferredUntil: now - 1 }, now)).toBe("now");
    expect(taskStatus({ ...free, queued: true }, now)).toBe("paused");
    expect(taskStatus({ ...free, waitingFor: "дочь" }, now)).toBe("paused");
    expect(pauseReason({ ...free, deferred: true, queued: true }, now)).toBe("deferred");
    expect(pauseReason({ ...free, queued: true }, now)).toBe("queued");
    expect(pauseReason({ ...free, waitingFor: "дочь" }, now)).toBe("waiting");
    expect(pauseReason(free, now)).toBeNull();
  });
});

describe("состав плана дня", () => {
  const now = Date.UTC(2026, 10, 27, 12);
  const today = "2026-11-27";
  const first = () => 0;

  it("за каждой кнопкой задача со своей отметкой, без повторов", () => {
    const plan = composePlan(
      [
        candidate("i", { important: true }),
        candidate("u", { urgent: true }),
        candidate("m", { impactful: true }),
        candidate("e", { easy: true }),
      ],
      today,
      tz,
      now,
      first,
    );
    expect(plan).toEqual([
      { slot: "important", position: 0, itemId: "i" },
      { slot: "urgent", position: 0, itemId: "u" },
      { slot: "impactful", position: 0, itemId: "m" },
      { slot: "easy", position: 0, itemId: "e" },
    ]);
  });

  it("дофамин за кнопки не попадает; без задач с отметкой берется задача с наибольшим приоритетом", () => {
    const plan = composePlan(
      [
        candidate("fun", { important: true, flavor: "dopamine" }),
        candidate("low", { easy: true }),
        candidate("high", { urgent: true, impactful: true }),
      ],
      today,
      tz,
      now,
      first,
    );
    expect(plan.map((pick) => [pick.slot, pick.itemId])).toEqual([
      ["important", "high"],
      ["urgent", "low"],
    ]);
  });

  it("дедлайны: просроченные и в пределах 7 дней по дате пользователя, по порядку срока; за кнопки они не идут", () => {
    const at = (date: string) => new Date(`${date}T00:00:00Z`).getTime();
    const plan = composePlan(
      [
        candidate("late", { important: true, deadline: at("2026-11-20") }),
        candidate("soon", { important: true, deadline: at("2026-12-04") }),
        candidate("far", { important: true, deadline: at("2026-12-05") }),
      ],
      today,
      tz,
      now,
      first,
    );
    expect(plan.map((pick) => [pick.slot, pick.position, pick.itemId])).toEqual([
      ["deadline", 0, "late"],
      ["deadline", 1, "soon"],
      ["important", 0, "far"],
    ]);
  });

  it("задачи на паузе идут в блок дедлайнов, но не за кнопки", () => {
    const at = (date: string) => new Date(`${date}T00:00:00Z`).getTime();
    const plan = composePlan(
      [
        candidate("deferred", { important: true, deadline: at("2026-12-01"), pause: "deferred" }),
        candidate("waiting", { important: true, pause: "waiting" }),
        candidate("free", { urgent: true }),
      ],
      today,
      tz,
      now,
      first,
    );
    expect(plan.map((pick) => [pick.slot, pick.itemId])).toEqual([
      ["deadline", "deferred"],
      ["important", "free"],
    ]);
  });

  it("шанс выше у задачи с большим приоритетом, у давно не показанной и у лягушки", () => {
    const pool = [
      candidate("plain", { important: true, lastShownAt: now }),
      candidate("frog", { important: true, lastShownAt: now, flavor: "frog" }),
    ];
    // веса: plain 3·1, frog 3·1·2; точка 0,5 из суммы 9 попадает в лягушку
    expect(composePlan(pool, today, tz, now, () => 0.5)[0]).toEqual({ slot: "important", position: 0, itemId: "frog" });
    const stale = [
      candidate("fresh", { important: true, lastShownAt: now }),
      candidate("old", { important: true, lastShownAt: now - 3 * DAY }),
    ];
    // веса: fresh 3·1, old 3·4; точка 0,25 из 15 попадает в old, 0,1 — в fresh
    expect(composePlan(stale, today, tz, now, () => 0.25)[0].itemId).toBe("old");
    expect(composePlan(stale, today, tz, now, () => 0.1)[0].itemId).toBe("fresh");
  });
});

let ann: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(async () => {
  await resetDb();
  ann = await createUser(1001, "Ann");
  bob = await createUser(2002, "Bob");
});

type TaskFields = Record<string, string | number | null>;

async function insertTask(ownerId: string, title: string, fields: TaskFields = {}, creatorId = ownerId): Promise<string> {
  const id = crypto.randomUUID();
  const columns = Object.keys(fields);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, kind, title, owner_id, creator_id, household_id, source, created_at, updated_at)
      SELECT ?, 'task', ?, ?, ?, household_id, 'web', 0, 0 FROM users WHERE id = ?`,
    ).bind(id, title, ownerId, creatorId, ownerId),
    env.DB.prepare(
      `INSERT INTO tasks (id${columns.map((c) => `, ${c}`).join("")}) VALUES (?${columns.map(() => ", ?").join("")})`,
    ).bind(id, ...Object.values(fields)),
  ]);
  return id;
}

type Today = {
  date: string;
  deadlines: { itemId: string; title: string; pause: string | null }[];
  buttons: Record<string, { itemId: string; title: string; priority: number; level: string } | undefined>;
};

async function today(token: string): Promise<Today> {
  const response = await api(token, "GET", "/today");
  expect(response.status).toBe(200);
  return response.json<Today>();
}

describe("план дня через API", () => {
  it("составляется из своих задач «можно сейчас» и за день не пересчитывается", async () => {
    await insertTask(ann.id, "позвонить врачу", { important: 1, why: "здоровье" });
    await insertTask(ann.id, "отложенная", { important: 1, why: "x", deferred: 1 });
    await insertTask(ann.id, "в очереди", { important: 1, why: "x", queued: 1 });
    await insertTask(ann.id, "жду", { important: 1, why: "x", waiting_for: "ответ" });
    await insertTask(ann.id, "проект", { important: 1, why: "x", is_project: 1 });
    const focus = await insertTask(ann.id, "проект в фокусе", { is_project: 1, in_focus: 1 });
    await insertTask(ann.id, "шаг проекта в фокусе", { important: 1, why: "x", project_id: focus });
    await insertTask(bob.id, "чужая", { important: 1, why: "x" });
    await insertTask(bob.id, "поручила Ann, но выполняет Bob", { important: 1, why: "x" }, ann.id);

    const plan = await today(ann.token);
    expect(plan.deadlines).toEqual([]);
    expect(Object.values(plan.buttons).map((task) => task?.title)).toEqual(["позвонить врачу"]);
    expect(plan.buttons.important).toMatchObject({ priority: 2, level: "medium" });

    await insertTask(ann.id, "новая срочная", { urgent: 1 });
    const again = await today(ann.token);
    expect(again).toEqual(plan);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM day_plan WHERE user_id = ?").bind(ann.id).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("в блоке дедлайнов задачи на паузе с причиной паузы", async () => {
    const soon = Date.now() + 86_400_000;
    await insertTask(ann.id, "отложенная со сроком", { deadline: soon, deferred: 1 });
    await insertTask(ann.id, "в очереди со сроком", { deadline: soon + 1, queued: 1 });
    await insertTask(ann.id, "жду со сроком", { deadline: soon + 2, waiting_for: "мастер" });
    await insertTask(ann.id, "можно со сроком", { deadline: soon + 3 });
    const plan = await today(ann.token);
    expect(plan.deadlines.map((task) => [task.title, task.pause])).toEqual([
      ["отложенная со сроком", "deferred"],
      ["в очереди со сроком", "queued"],
      ["жду со сроком", "waiting"],
      ["можно со сроком", null],
    ]);
    expect(plan.buttons).toEqual({});
  });

  it("одновременные первые запросы дают один план", async () => {
    for (const mark of ["important", "urgent", "impactful", "easy"]) {
      await insertTask(ann.id, mark, { [mark]: 1, why: "x" });
      await insertTask(ann.id, `${mark} 2`, { [mark]: 1, why: "x" });
    }
    const [a, b] = await Promise.all([today(ann.token), today(ann.token)]);
    expect(a).toEqual(b);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM day_plan WHERE user_id = ?").bind(ann.id).first<{ n: number }>();
    expect(rows?.n).toBe(4);
  });

  it("без задач план пустой и не записывается", async () => {
    const plan = await today(ann.token);
    expect(plan).toMatchObject({ deadlines: [], buttons: {} });
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM day_plan").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("без входа недоступен", async () => {
    expect((await api("wrong", "GET", "/today")).status).toBe(401);
  });
});

type TaskView = {
  id: string;
  title: string;
  priority: number;
  level: string;
  status: string;
  sphereIds: string[];
  ownerName: string | null;
};

describe("вкладка «Задачи»", () => {
  it("видны свои задачи и поручения автора, с приоритетом и статусом; инбокс и архив не видны", async () => {
    const sphere = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO spheres (id, user_id, name) VALUES (?, ?, 'дом')").bind(sphere, ann.id).run();
    const mine = await insertTask(ann.id, "купить краску", { important: 1, urgent: 1, why: "ремонт" });
    await env.DB.prepare("INSERT INTO item_spheres (item_id, sphere_id) VALUES (?, ?)").bind(mine, sphere).run();
    await insertTask(ann.id, "жду ответа", { waiting_for: "мастер" });
    await insertTask(bob.id, "Bob делает для Ann", {}, ann.id);
    await insertTask(bob.id, "только Bob", {});
    const archived = await insertTask(ann.id, "в архиве", {});
    await env.DB.prepare("UPDATE items SET archived_at = 1 WHERE id = ?").bind(archived).run();
    await api(ann.token, "POST", "/inbox", { title: "мысль из инбокса" });

    const body = await (await api(ann.token, "GET", "/tasks")).json<{ tasks: TaskView[] }>();
    const byTitle = Object.fromEntries(body.tasks.map((task) => [task.title, task]));
    expect(Object.keys(byTitle).sort()).toEqual(["Bob делает для Ann", "жду ответа", "купить краску"].sort());
    expect(byTitle["купить краску"]).toMatchObject({ priority: 3, level: "medium", status: "now", sphereIds: [sphere] });
    expect(byTitle["жду ответа"]).toMatchObject({ priority: 0, level: "none", status: "paused", ownerName: null });
    expect(byTitle["Bob делает для Ann"].ownerName).toBe("Bob");

    const bobView = await (await api(bob.token, "GET", "/tasks")).json<{ tasks: TaskView[] }>();
    expect(bobView.tasks.map((task) => task.title).sort()).toEqual(["Bob делает для Ann", "только Bob"].sort());
  });
});
