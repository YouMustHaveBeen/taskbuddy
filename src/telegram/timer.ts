import { InlineKeyboard } from "grammy/web";
import type { TextKey } from "../../i18n";
import { localDate, localTime, type PlanTask, type TodayView } from "../core/day";
import { items } from "../core/items";
import { defaults } from "../core/settings";
import { timer, type TimerResult, type TimerView } from "../core/timer";
import type { BotPrompt } from "../db/botPrompts";
import { ask, clearPrompts, data, markAnswered, markStale, say, sendList, type Tg } from "./common";

/** Как показан таймер: идет или на паузе, «Стоп» нажат или время вышло. */
type Shown = "live" | "stopped" | "ended";

/** Текст сообщения таймера по его состоянию. */
function timerText(tg: Tg, current: TimerView, shown: Shown): string {
  if (current.state === "running" && current.endsAt !== null) {
    return say(tg.user, "timer.running", { title: current.title, time: localTime(current.endsAt, tg.user.timezone) });
  }
  if (current.state === "paused") {
    return say(tg.user, "timer.paused", { title: current.title, count: Math.ceil((current.remainingSec ?? 0) / 60) });
  }
  return say(tg.user, shown === "ended" ? "timer.ended" : "timer.stopped", { title: current.title });
}

/** Кнопки таймера: пока идет — «Пауза» (или «Продолжить»), «Стоп», «Парковка»; после остановки — четыре кнопки. */
function timerKeyboard(tg: Tg, current: TimerView): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (current.state === "ended") {
    return keyboard
      .text(say(tg.user, "timer.finish"), data("t", "f"))
      .text(say(tg.user, "timer.again"), data("t", "c"))
      .row()
      .text(say(tg.user, "timer.later"), data("t", "l"))
      .text(say(tg.user, "timer.return"), data("t", "b"));
  }
  if (current.state === "running") keyboard.text(say(tg.user, "timer.pause"), data("t", "p"));
  else keyboard.text(say(tg.user, "timer.resume"), data("t", "r"));
  keyboard.text(say(tg.user, "timer.stop"), data("t", "x"));
  if (current.kind === "task") keyboard.row().text(say(tg.user, "timer.park"), data("t", "k"));
  return keyboard;
}

/** Кнопки длины таймера; `press` — данные кнопки для длины. */
function lengths(tg: Tg, press: (minutes: number) => string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const minutes of defaults.timerMinutes) keyboard.text(say(tg.user, "timer.minutes", { count: minutes }), press(minutes));
  return keyboard;
}

async function editTimer(tg: Tg, messageId: number, current: TimerView, shown: Shown = "live") {
  await tg.api
    .editMessageText(tg.user.telegramId, messageId, timerText(tg, current, shown), { reply_markup: timerKeyboard(tg, current) })
    .catch(() => undefined);
}

/** Будильник ставится на окончание идущего таймера. */
async function arm(tg: Tg, current: TimerView | undefined) {
  if (current?.state === "running" && current.endsAt !== null) await tg.alarm(tg.user.id, current.endsAt);
}

/** «Таймер» у задачи: сообщение с названием задачи и кнопками длины. */
export async function sendTimerChoice(tg: Tg, date: string, task: PlanTask): Promise<void> {
  await tg.api.sendMessage(tg.user.telegramId, task.title, {
    reply_markup: lengths(tg, (minutes) => data("ts", date, task.slot, task.position, minutes)),
  });
}

/** Таймер уже идет: «Уже идет таймер»; таймер из бота дальше показывается в этом сообщении, прежнее удаляется. */
async function sendBusy(tg: Tg, current: TimerView) {
  const busy = say(tg.user, "timer.busy", { title: current.title });
  // таймер, запущенный на странице, в боте не показывается
  if (current.startedIn === "web") {
    await tg.api.sendMessage(tg.user.telegramId, busy);
    return;
  }
  const text = `${busy}\n\n${timerText(tg, current, "stopped")}`;
  const sent = await tg.api.sendMessage(tg.user.telegramId, text, { reply_markup: timerKeyboard(tg, current) });
  if (current.botMessageId !== null) await tg.api.deleteMessage(tg.user.telegramId, current.botMessageId).catch(() => undefined);
  await timer.setMessage(tg.db, tg.user.id, current.itemId, sent.message_id);
}

/** Запуск таймера из бота: сообщение с кнопками длины становится сообщением таймера. */
async function started(tg: Tg, messageId: number, messageText: string, result: TimerResult) {
  if (result.outcome === "ok" && result.timer) {
    await editTimer(tg, messageId, result.timer);
    await arm(tg, result.timer);
  } else if (result.outcome === "busy" && result.timer) {
    await tg.api.deleteMessage(tg.user.telegramId, messageId).catch(() => undefined);
    await sendBusy(tg, result.timer);
  } else {
    await markStale(tg, messageId, messageText);
  }
}

/** Время вышло (будильник): сообщение «Время вышло» с четырьмя кнопками приходит заново, прежнее удаляется. */
export async function sendTimerEnded(tg: Tg, current: TimerView): Promise<void> {
  if (current.botMessageId !== null) await tg.api.deleteMessage(tg.user.telegramId, current.botMessageId).catch(() => undefined);
  const sent = await tg.api.sendMessage(tg.user.telegramId, timerText(tg, current, "ended"), { reply_markup: timerKeyboard(tg, current) });
  await timer.setMessage(tg.db, tg.user.id, current.itemId, sent.message_id);
}

/** Таймер изменили на странице: сообщение таймера в боте показывает то же; после кнопок завершения — отмечается ответ. */
export async function showTimerInBot(tg: Tg, before: TimerView | undefined, after: TimerView | undefined, closed?: TextKey): Promise<void> {
  const messageId = before?.botMessageId ?? after?.botMessageId ?? null;
  if (messageId === null) return;
  if (closed && before) await markAnswered(tg, messageId, timerText(tg, before, "stopped"), closed);
  else if (after) await editTimer(tg, messageId, after, "stopped");
}

const closeLabels = { finish: "timer.finish", later: "timer.later", back: "timer.return" } as const satisfies Record<string, TextKey>;

/** «Завершить», «Продолжить позже», «Вернуть»: ответ отмечается на сообщении таймера; список на сегодня присылается заново. */
async function close(tg: Tg, messageId: number, messageText: string, action: "finish" | "later" | "back", blocks?: string) {
  const result = await timer.close(tg.db, tg.user, Date.now(), action, blocks ? { blocks } : undefined);
  if (result.outcome !== "ok" || !result.timer) {
    await markStale(tg, messageId, messageText);
    return;
  }
  await markAnswered(tg, messageId, timerText(tg, result.timer, "stopped"), closeLabels[action]);
  if (action !== "later" && result.today) await sendList(tg, result.today);
}

/** Строка плана задачи таймера, если по ней нужно спросить «Что мешает?». */
function asksBlocks(today: TodayView, itemId: string): boolean {
  const rows = [...today.deadlines, ...today.picked, ...Object.values(today.buttons)];
  return rows.some((row) => row.itemId === itemId && row.askBlocks && row.flavor !== "dopamine");
}

/** Кнопки таймера в боте: «tm» — выбор длины, «ts» — запуск, «t|…» — кнопки идущего и остановленного таймера. */
export async function onTimerCallback(tg: Tg, messageId: number, messageText: string, parts: string[], today: () => Promise<TodayView>) {
  const now = Date.now();
  if (parts[0] === "ts" && parts.length === 5) {
    const [, date, slot, rawPosition, rawMinutes] = parts;
    if (date !== localDate(now, tg.user.timezone)) {
      await markStale(tg, messageId, messageText);
      return;
    }
    const target = { slot, position: Number(rawPosition), minutes: Number(rawMinutes) };
    await started(tg, messageId, messageText, await timer.start(tg.db, tg.user, now, target, "bot", messageId));
    return;
  }
  if (parts[0] === "tn" && parts.length === 2) {
    await started(tg, messageId, messageText, await timer.again(tg.db, tg.user, now, Number(parts[1]), "bot", messageId));
    return;
  }
  if (parts[0] !== "t" || parts.length !== 2) return;
  const current = await timer.current(tg.db, tg.user.id);
  if (!current || current.botMessageId !== messageId) {
    await markStale(tg, messageId, messageText);
    return;
  }
  const action = parts[1];
  if (action === "p" || action === "r" || action === "x") {
    const result =
      action === "p"
        ? await timer.pause(tg.db, tg.user.id, now)
        : action === "r"
          ? await timer.resume(tg.db, tg.user.id, now)
          : await timer.stop(tg.db, tg.user.id);
    if (result.timer) await editTimer(tg, messageId, result.timer, "stopped");
    if (action === "r") await arm(tg, result.timer);
    return;
  }
  if (action === "k" && current.state !== "ended") {
    await ask(tg, messageId, parkPrompt(tg, now), "timer.park.prompt");
    return;
  }
  if (action === "c" && current.state === "ended") {
    await tg.api
      .editMessageText(tg.user.telegramId, messageId, current.title, { reply_markup: lengths(tg, (minutes) => data("tn", minutes)) })
      .catch(() => undefined);
    return;
  }
  if (action === "f" || action === "l") {
    await close(tg, messageId, messageText, action === "f" ? "finish" : "later");
    return;
  }
  if (action === "b") {
    if (asksBlocks(await today(), current.itemId)) {
      const keyboard = new InlineKeyboard().text(say(tg.user, "action.skip"), data("t", "bs"));
      await tg.api
        .editMessageText(tg.user.telegramId, messageId, `${messageText}\n\n${say(tg.user, "today.blocks")}`, { reply_markup: keyboard })
        .catch(() => undefined);
      await ask(tg, messageId, { ...parkPrompt(tg, now), kind: "return" }, "today.blocks");
    } else {
      await close(tg, messageId, messageText, "back");
    }
    return;
  }
  if (action === "bs") {
    await clearPrompts(tg, messageId);
    await close(tg, messageId, timerText(tg, current, "stopped"), "back");
  }
}

/** Вопрос «Парковки» и «Что мешает?» после «Вернуть» не привязан к строке плана. */
function parkPrompt(tg: Tg, now: number): Omit<BotPrompt, "userId" | "messageId" | "cardMessageId"> {
  return { kind: "park", date: localDate(now, tg.user.timezone), slot: "", position: 0, action: null };
}

/** Ответ на вопрос «Парковки» (мысль в инбокс) или на «Что мешает?» после «Вернуть». */
export async function answerTimerPrompt(tg: Tg, prompt: BotPrompt, text: string): Promise<void> {
  if (prompt.kind === "park") {
    await items.addInbox(tg.db, tg.user.id, text, "bot");
    return;
  }
  const current = await timer.current(tg.db, tg.user.id);
  if (!current || current.botMessageId !== prompt.cardMessageId) return;
  await close(tg, prompt.cardMessageId, timerText(tg, current, "stopped"), "back", text);
}
