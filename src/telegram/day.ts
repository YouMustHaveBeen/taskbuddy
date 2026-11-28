import { InlineKeyboard, type Api } from "grammy/web";
import { t, type Language, type TextKey } from "../../i18n";
import { buttonSlots, day, localDate, type ButtonSlot, type DayResult, type PlanTask, type TodayView } from "../core/day";
import { schedule } from "../core/schedule";
import { dropPrompts, savePrompt, setListMessage, takePrompt, type BotPrompt } from "../db/botPrompts";
import type { Db } from "../db/client";
import type { User } from "../db/users";

/** Бот для одного пользователя: API Telegram, база, пользователь и адрес страницы (для кнопки «Выбрать»). */
export type Tg = { api: Api; db: Db; user: User; url: string };

type Step = "why" | "blocks";
type Answer = "tomorrow" | "back" | "drop";
const answers: readonly Answer[] = ["tomorrow", "back", "drop"];
const answerLabels: Record<Answer, TextKey> = { tomorrow: "survey.tomorrow", back: "survey.back", drop: "action.delete" };

const say = (user: User, key: TextKey, vars?: Record<string, string | number>) => t(user.language as Language, key, vars);
const data = (...parts: (string | number)[]) => parts.join("|");
const isButton = (slot: string): slot is ButtonSlot => (buttonSlots as readonly string[]).includes(slot);

/** Текущая строка слота кнопки или строка «Выбрать» / «Подумай» по позиции. */
function findTask(view: TodayView, slot: string, position: number): PlanTask | undefined {
  if (isButton(slot)) return view.buttons[slot];
  return view.picked.find((task) => task.slot === slot && task.position === position);
}

/** Шаг отказа в боте: сначала «зачем» (если есть), затем «Что мешает?» (если спрашивается); иначе отказ завершается сразу. */
function refusedStep(task: PlanTask): Step | undefined {
  if (task.reasonPrompt) return "why";
  return task.askBlocks ? "blocks" : undefined;
}

/** Карточка задачи из плана: текст и кнопки по ее состоянию. */
function card(user: User, date: string, task: PlanTask, step?: Step, note?: string): { text: string; keyboard?: InlineKeyboard } {
  const head = isButton(task.slot) ? `${say(user, `slot.${task.slot}`)}: ${task.title}` : task.title;
  const lines = [head];
  if (task.firstStep) lines.push(task.firstStep);
  const act = (action: string) => data("d", date, task.slot, task.position, action);
  const dopamine = task.flavor === "dopamine";
  const keyboard = new InlineKeyboard();
  if (task.state === "offered") {
    keyboard.text(say(user, "action.accept"), act("accept"));
    if (dopamine) keyboard.text(say(user, "action.skip"), act("release"));
    else keyboard.text(say(user, "action.refuse"), act("refuse"));
  } else if (task.state === "accepted") {
    keyboard.text(say(user, "action.done"), act("done"));
    if (dopamine) keyboard.text(say(user, "action.close"), act("release"));
  } else if (task.state === "refused") {
    if ((step ?? refusedStep(task)) === "why" && task.reasonPrompt) {
      lines.push("", say(user, "today.why", { why: task.reasonPrompt }));
      keyboard
        .text(say(user, "action.takeAnyway"), act("accept"))
        .row()
        .text(say(user, "action.writeReason"), act("wr"))
        .row()
        .text(say(user, "action.skip"), act("sw"));
    } else {
      lines.push("", say(user, "today.blocks"));
      keyboard.text(say(user, "action.skip"), act("sb"));
    }
  } else if (task.state === "done" || (task.state === "closed" && dopamine)) {
    lines[0] = `✓ ${head}`;
    if (isButton(task.slot)) {
      keyboard.text(say(user, "action.dopamine"), act("dopamine")).text(say(user, "action.refresh"), act("refresh"));
    }
  } else {
    lines.push("", say(user, "today.noMore"));
  }
  if (note) lines.push("", note);
  return { text: lines.join("\n"), keyboard: keyboard.inline_keyboard.length > 0 ? keyboard : undefined };
}

async function editCard(tg: Tg, messageId: number, view: TodayView, task: PlanTask, step?: Step, note?: string, stale = false) {
  const shown = card(tg.user, view.date, task, step, note);
  const text = stale ? `${say(tg.user, "bot.stale")}\n\n${shown.text}` : shown.text;
  await tg.api
    .editMessageText(tg.user.telegramId, messageId, text, { reply_markup: shown.keyboard ?? { inline_keyboard: [] } })
    .catch(() => undefined);
}

/** Карточка показывает актуальное состояние слота, если нажатая кнопка уже устарела. */
async function showStale(tg: Tg, messageId: number, slot: string, position: number, messageText?: string) {
  const view = await day.today(tg.db, tg.user, Date.now());
  const task = findTask(view, slot, position);
  if (task) await editCard(tg, messageId, view, task, undefined, undefined, true);
  else if (messageText) await markStale(tg, messageId, messageText);
  else await tg.api.editMessageReplyMarkup(tg.user.telegramId, messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
}

/** Вопрос, ответом на который считается ответ на это сообщение. */
async function ask(tg: Tg, cardMessageId: number, prompt: Omit<BotPrompt, "userId" | "messageId" | "cardMessageId">, question: TextKey) {
  const sent = await tg.api.sendMessage(tg.user.telegramId, `${say(tg.user, question)}\n${say(tg.user, "bot.replyHint")}`, {
    reply_markup: { force_reply: true },
  });
  try {
    await savePrompt(tg.db, { ...prompt, userId: tg.user.id, messageId: sent.message_id, cardMessageId }, Date.now());
  } catch (error) {
    // вопрос не записан: он удаляется из чата
    await tg.api.deleteMessage(tg.user.telegramId, sent.message_id).catch(() => undefined);
    throw error;
  }
}

/** Убирает вопросы к карточке: по ним уже ответили кнопкой или пропустили. */
async function clearPrompts(tg: Tg, cardMessageId: number) {
  for (const messageId of await dropPrompts(tg.db, tg.user.id, cardMessageId)) {
    await tg.api.deleteMessage(tg.user.telegramId, messageId).catch(() => undefined);
  }
}

/** Список на сегодня: старое сообщение удаляется, новое присылается последним в чате. */
export async function sendList(tg: Tg, view: TodayView): Promise<void> {
  const lines = [say(tg.user, "bot.list.title"), ""];
  if (view.list.length === 0) lines.push(say(tg.user, "bot.list.empty"));
  for (const task of view.list) lines.push(`${task.state === "done" ? "✓" : "•"} ${task.title}`);
  // «Сделано: название» под списком — для каждой принятой несделанной задачи
  const keyboard = new InlineKeyboard();
  for (const task of view.list.filter((row) => row.state === "accepted")) {
    keyboard.text(say(tg.user, "bot.list.done", { title: task.title }), data("l", view.date, task.slot, task.position)).row();
  }
  if (tg.user.listMessageId !== null) {
    await tg.api.deleteMessage(tg.user.telegramId, tg.user.listMessageId).catch(() => undefined);
  }
  const sent = await tg.api.sendMessage(tg.user.telegramId, lines.join("\n"), {
    reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
  });
  await setListMessage(tg.db, tg.user.id, sent.message_id);
  tg.user.listMessageId = sent.message_id;
}

/** Утро: сообщение «Выдай мне дело» с пятью кнопками и список на сегодня. */
export async function sendMorning(tg: Tg, view: TodayView): Promise<void> {
  const press = (slot: ButtonSlot) => data("b", view.date, slot);
  const keyboard = new InlineKeyboard()
    .text(say(tg.user, "slot.important"), press("important"))
    .text(say(tg.user, "slot.urgent"), press("urgent"))
    .row()
    .text(say(tg.user, "slot.impactful"), press("impactful"))
    .text(say(tg.user, "slot.easy"), press("easy"))
    .row()
    .webApp(say(tg.user, "slot.pick"), `${tg.url}/?pick=1`);
  await tg.api.sendMessage(tg.user.telegramId, say(tg.user, "bot.five.title"), { reply_markup: keyboard });
  await sendList(tg, view);
}

/** Вопрос опроса по первой задаче из `survey`; `first` — утром перед ним «Сначала вчерашний опрос». */
export async function sendSurvey(tg: Tg, view: TodayView, first = false): Promise<void> {
  const task = view.survey[0];
  if (!task) return;
  if (first) await tg.api.sendMessage(tg.user.telegramId, say(tg.user, "survey.first"));
  const keyboard = new InlineKeyboard();
  for (const answer of answers) {
    keyboard.text(say(tg.user, answerLabels[answer]), data("s", task.date, task.slot, task.position, answer));
  }
  await tg.api.sendMessage(tg.user.telegramId, `${say(tg.user, "survey.question")}\n\n${task.title}`, { reply_markup: keyboard });
}

export async function sendReminder(tg: Tg, itemId: string, title: string, remindAt: number): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text(say(tg.user, "action.takeToday"), data("r", "t", itemId))
    .row()
    .text(say(tg.user, "action.remindTomorrow"), data("r", "a", itemId, remindAt));
  await tg.api.sendMessage(tg.user.telegramId, say(tg.user, "bot.reminder", { title }), { reply_markup: keyboard });
}

/** Предел длины сообщения Telegram. */
const messageLimit = 4096;

/** «Завтра дедлайн: название» по строке на задачу; длинный список делится на несколько сообщений. */
export async function sendDeadlines(tg: Tg, titles: string[]): Promise<void> {
  const chunks: string[] = [];
  for (const title of titles) {
    const line = say(tg.user, "bot.deadlineTomorrow", { title }).slice(0, messageLimit);
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + 1 + line.length <= messageLimit) chunks[last] += `\n${line}`;
    else chunks.push(line);
  }
  for (const chunk of chunks) await tg.api.sendMessage(tg.user.telegramId, chunk);
}

/** Сообщение без кнопок с отметкой выбранного ответа. */
async function markAnswered(tg: Tg, messageId: number, text: string, label: TextKey) {
  await tg.api.editMessageText(tg.user.telegramId, messageId, `${text}\n\n✓ ${say(tg.user, label)}`, {
    reply_markup: { inline_keyboard: [] },
  }).catch(() => undefined);
}

/** Кнопка устарела (задачу удалили или изменили): кнопки снимаются, на сообщении «Это уже изменилось». */
async function markStale(tg: Tg, messageId: number, text: string) {
  await tg.api.editMessageText(tg.user.telegramId, messageId, `${text}\n\n${say(tg.user, "bot.stale")}`, {
    reply_markup: { inline_keyboard: [] },
  }).catch(() => undefined);
}

/** После ответа опроса: следующий вопрос или «Опрос пройден», а если опрос открыл утро — пять кнопок и список. */
async function continueSurvey(tg: Tg, view: TodayView) {
  if (view.survey.length > 0) {
    await sendSurvey(tg, view);
    return;
  }
  await tg.api.sendMessage(tg.user.telegramId, say(tg.user, "bot.survey.done"));
  const now = Date.now();
  const previous = tg.user.morningOn;
  if (!view.locked && (await schedule.claimMorning(tg.db, tg.user, now))) {
    try {
      await sendMorning(tg, await day.today(tg.db, tg.user, now));
    } catch (error) {
      // утро не отправилось: отметка возвращается, утро пришлет ближайший запуск расписания
      await schedule.release(tg.db, tg.user.id, { column: "morning_on", date: localDate(now, tg.user.timezone), previous });
      throw error;
    }
    return;
  }
  // ответы опроса меняют список на сегодня: после опроса он присылается заново
  if (!view.locked) await sendList(tg, view);
}

/** Записывает ответ опроса и показывает его на сообщении вопроса. */
async function commitSurvey(tg: Tg, messageId: number, task: PlanTask, answer: Answer, blocks?: string) {
  const result = await day.survey(
    tg.db,
    tg.user,
    Date.now(),
    { date: task.date, slot: task.slot, position: task.position, answer },
    blocks ? { blocks } : undefined,
  );
  if (result.outcome === "ok") {
    await markAnswered(tg, messageId, `${say(tg.user, "survey.question")}\n\n${task.title}`, answerLabels[answer]);
  } else {
    await tg.api.editMessageReplyMarkup(tg.user.telegramId, messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  }
  await continueSurvey(tg, result.today ?? (await day.today(tg.db, tg.user, Date.now())));
}

/** Завершение отказа: замена или закрытие слота; ответ «Что мешает?» — в инсайты. */
async function finishRefusal(tg: Tg, messageId: number, slot: string, position: number, blocks?: string) {
  const result = await day.act(tg.db, tg.user, Date.now(), { slot, position, action: "next" }, blocks ? { blocks } : undefined);
  await show(tg, messageId, result, slot, position);
}

/** Карточка после действия: новое состояние слота или актуальное, если действие не прошло. */
async function show(tg: Tg, messageId: number, result: DayResult, slot: string, position: number) {
  if (result.outcome !== "ok" || !result.today) {
    await showStale(tg, messageId, slot, position);
    return;
  }
  const task = findTask(result.today, slot, position);
  if (task) await editCard(tg, messageId, result.today, task);
}

/** Шаг после «зачем»: «Что мешает?» (вопрос ответом на сообщение) или сразу завершение отказа. */
async function afterWhy(tg: Tg, messageId: number, view: TodayView, task: PlanTask) {
  if (task.askBlocks) {
    await editCard(tg, messageId, view, task, "blocks");
    await ask(tg, messageId, { kind: "blocks", date: view.date, slot: task.slot, position: task.position, action: null }, "today.blocks");
  } else {
    await finishRefusal(tg, messageId, task.slot, task.position);
  }
}

/** Нажатие кнопки на сообщениях плана дня, опроса и напоминаний. */
export async function onCallback(tg: Tg, messageId: number, messageText: string, raw: string): Promise<void> {
  const parts = raw.split("|");
  const now = Date.now();
  if (parts[0] === "b" && parts.length === 3) {
    const slot = parts[2];
    let view = await day.today(tg.db, tg.user, now);
    if (view.locked) {
      await sendSurvey(tg, view, true);
      return;
    }
    let task = isButton(slot) ? view.buttons[slot] : undefined;
    if (task?.hidden) {
      const revealed = await day.act(tg.db, tg.user, now, { slot, position: task.position, action: "reveal" }, undefined);
      if (revealed.today) view = revealed.today;
      task = isButton(slot) ? view.buttons[slot] : undefined;
    }
    if (!task) {
      await tg.api.sendMessage(tg.user.telegramId, say(tg.user, "today.noMore"));
      return;
    }
    const shown = card(tg.user, view.date, task);
    await tg.api.sendMessage(tg.user.telegramId, shown.text, { reply_markup: shown.keyboard });
    return;
  }

  if (parts[0] === "d" && parts.length === 5) {
    const [, date, slot, rawPosition, action] = parts;
    const position = Number(rawPosition);
    if (date !== localDate(now, tg.user.timezone)) {
      await showStale(tg, messageId, slot, position, messageText);
      return;
    }
    if (action === "wr") {
      await ask(tg, messageId, { kind: "reason", date, slot, position, action: null }, "bot.reason.prompt");
      return;
    }
    if (action === "sw" || action === "sb" || action === "accept") await clearPrompts(tg, messageId);
    if (action === "sb") {
      await finishRefusal(tg, messageId, slot, position);
      return;
    }
    if (action === "sw") {
      const view = await day.today(tg.db, tg.user, now);
      const task = findTask(view, slot, position);
      if (!task || task.state !== "refused" || task.position !== position) await showStale(tg, messageId, slot, position, messageText);
      else await afterWhy(tg, messageId, view, task);
      return;
    }
    const result = await day.act(tg.db, tg.user, now, { slot, position, action }, undefined);
    if (result.outcome === "none" && result.today === undefined) {
      const view = await day.today(tg.db, tg.user, now);
      const task = findTask(view, slot, position);
      if (task) await editCard(tg, messageId, view, task, undefined, say(tg.user, action === "dopamine" ? "today.noDopamine" : "today.noMore"));
      return;
    }
    if (result.outcome !== "ok" || !result.today) {
      await showStale(tg, messageId, slot, position, messageText);
      return;
    }
    const task = findTask(result.today, slot, position);
    if (!task) return;
    if (action === "refuse") {
      const step = refusedStep(task);
      if (step === "why") await editCard(tg, messageId, result.today, task, "why");
      else await afterWhy(tg, messageId, result.today, task);
      return;
    }
    await editCard(tg, messageId, result.today, task);
    if (action === "accept" || action === "done") await sendList(tg, result.today);
    return;
  }

  if (parts[0] === "s" && (parts.length === 5 || parts.length === 6)) {
    const [, date, slot, rawPosition, answer, skip] = parts;
    const position = Number(rawPosition);
    if (!(answers as readonly string[]).includes(answer)) return;
    if (skip) await clearPrompts(tg, messageId);
    const view = await day.today(tg.db, tg.user, now);
    const task = view.survey.find((row) => row.date === date && row.slot === slot && row.position === position);
    if (!task) {
      await tg.api.editMessageReplyMarkup(tg.user.telegramId, messageId, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      await continueSurvey(tg, view);
      return;
    }
    if (!skip && answer !== "drop" && task.askBlocks) {
      const keyboard = new InlineKeyboard().text(say(tg.user, "action.skip"), data("s", date, slot, position, answer, "k"));
      const text = `${say(tg.user, "survey.question")}\n\n${task.title}\n\n${say(tg.user, "today.blocks")}`;
      await tg.api.editMessageText(tg.user.telegramId, messageId, text, { reply_markup: keyboard }).catch(() => undefined);
      await ask(tg, messageId, { kind: "survey", date, slot, position, action: answer }, "today.blocks");
      return;
    }
    await commitSurvey(tg, messageId, task, answer as Answer);
    return;
  }

  if (parts[0] === "r" && parts[1] === "t" && parts.length === 3) {
    const result = await day.pick(tg.db, tg.user, now, parts[2]);
    if (result.today?.locked) {
      // сначала вчерашний опрос; кнопки напоминания остаются, чтобы взять задачу после него
      await sendSurvey(tg, result.today, true);
      return;
    }
    if (result.outcome === "ok" && result.today) {
      await markAnswered(tg, messageId, messageText, "action.takeToday");
      await sendList(tg, result.today);
    } else {
      await markStale(tg, messageId, messageText);
    }
    return;
  }

  if (parts[0] === "r" && parts[1] === "a" && parts.length === 4) {
    const original = Number(parts[3]);
    if (Number.isFinite(original) && (await schedule.remindTomorrow(tg.db, tg.user, parts[2], original, now))) {
      await markAnswered(tg, messageId, messageText, "action.remindTomorrow");
    } else {
      await markStale(tg, messageId, messageText);
    }
    return;
  }

  if (parts[0] === "l" && parts.length === 4) {
    const [, date, slot, rawPosition] = parts;
    const position = Number(rawPosition);
    const result =
      date === localDate(now, tg.user.timezone)
        ? await day.act(tg.db, tg.user, now, { slot, position, action: "done" }, undefined)
        : undefined;
    await sendList(tg, result?.today ?? (await day.today(tg.db, tg.user, now)));
  }
}

/** Ответ на вопрос бота (причина отказа, «Что мешает?»). Возвращает false, если это ответ не на вопрос бота. */
export async function onReply(tg: Tg, replyTo: number, text: string): Promise<boolean> {
  const prompt = await takePrompt(tg.db, tg.user.id, replyTo);
  if (!prompt) return false;
  const now = Date.now();
  try {
    await answerPrompt(tg, prompt, text, now);
  } catch (error) {
    // ответ не обработан: вопрос возвращается, на него можно ответить еще раз
    await savePrompt(tg.db, prompt, now).catch(() => undefined);
    throw error;
  }
  return true;
}

async function answerPrompt(tg: Tg, prompt: BotPrompt, text: string, now: number): Promise<void> {
  const { cardMessageId, slot, position } = prompt;
  const today = localDate(now, tg.user.timezone);
  if (prompt.kind === "reason") {
    // ответ после полуночи относится к строке вчерашнего плана: в сегодняшнюю он не записывается
    if (prompt.date !== today) {
      await showStale(tg, cardMessageId, slot, position);
      return;
    }
    const result = await day.act(tg.db, tg.user, now, { slot, position, action: "reason" }, { text });
    const view = result.today ?? (await day.today(tg.db, tg.user, now));
    const task = findTask(view, slot, position);
    if (task && task.state === "refused" && task.position === position) await afterWhy(tg, cardMessageId, view, task);
    else await showStale(tg, cardMessageId, slot, position);
  } else if (prompt.kind === "blocks") {
    if (prompt.date === today) await finishRefusal(tg, cardMessageId, slot, position, text);
    else await showStale(tg, cardMessageId, slot, position);
  } else if (prompt.action && (answers as readonly string[]).includes(prompt.action)) {
    const view = await day.today(tg.db, tg.user, now);
    const task = view.survey.find((row) => row.date === prompt.date && row.slot === slot && row.position === position);
    if (task) await commitSurvey(tg, cardMessageId, task, prompt.action as Answer, text);
    else await continueSurvey(tg, view);
  }
}
