import { Fragment, useCallback, useEffect, useState } from "react";
import { t, type Language, type TextKey } from "../../i18n";
import { api } from "./api";
import { TextField } from "./Inbox";
import { Tasks } from "./Tasks";
import { TimerButton, TimerPanel, type TimerReply, type TimerView } from "./Timer";

type Slot = "important" | "urgent" | "impactful" | "easy";
type Pause = "deferred" | "queued" | "waiting";
type PlanRow = {
  date: string;
  slot: string;
  position: number;
  itemId: string;
  title: string;
  state: "offered" | "accepted" | "refused" | "done" | "returned" | "closed" | "tomorrow" | "dropped";
  hidden: boolean;
  flavor: "dopamine" | "frog" | null;
  deadline: number | null;
  level: "top" | "high" | "medium" | "low" | "none";
  pause: Pause | null;
  firstStep: string | null;
  hasVoice: boolean;
  reasonPrompt: string | null;
  askBlocks: boolean;
};
/** Награда списка на сегодня: у прошедших и открытой есть название, следующие скрыты. */
type ListReward = { position: number; open: boolean; title: string | null; minutes: number | null };
type TodayView = {
  deadlines: PlanRow[];
  buttons: Partial<Record<Slot, PlanRow>>;
  picked: PlanRow[];
  list: PlanRow[];
  rewards: ListReward[];
  survey: PlanRow[];
  locked: boolean;
  done: number;
  ringTasks: number;
  timer: TimerView | null;
  timerMinutes: number[];
};
type Answer = "tomorrow" | "back" | "drop";
type Step = "why" | "write" | "blocks";

const slots: Slot[] = ["important", "urgent", "impactful", "easy"];
const slotLabels: Record<Slot, TextKey> = {
  important: "slot.important",
  urgent: "slot.urgent",
  impactful: "slot.impactful",
  easy: "slot.easy",
};
const pauseLabels: Record<Pause, TextKey> = {
  deferred: "field.deferred",
  queued: "field.queued",
  waiting: "field.waitingFor",
};
const levelLabels: Record<PlanRow["level"], TextKey> = {
  top: "level.top",
  high: "level.high",
  medium: "level.medium",
  low: "level.low",
  none: "level.none",
};

type Props = { language: Language; onSignedOut: () => void; ring: boolean };

export function Today({ language, onSignedOut, ring }: Props) {
  const text = (key: TextKey, params?: Record<string, string | number>) => t(language, key, params);
  const [view, setView] = useState<TodayView>();
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<TextKey>();
  const [busy, setBusy] = useState(false);
  /** План дня из ответа действия (без таймера): таймер остается прежним. */
  const setPlan = (plan: Omit<TodayView, "timer" | "timerMinutes">) =>
    setView((current) => ({ ...plan, timer: current?.timer ?? null, timerMinutes: current?.timerMinutes ?? [] }));
  // из бота кнопка «Выбрать» открывает страницу сразу в режиме выбора
  const [choosing, setChoosing] = useState(() => ring && new URLSearchParams(location.search).has("pick"));
  // после открытия ?pick=1 убирается из адреса
  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("pick")) return;
    url.searchParams.delete("pick");
    history.replaceState(null, "", url);
  }, []);

  const load = useCallback(async () => {
    const result = await api<TodayView>("GET", "/today");
    if (result.status === 401) onSignedOut();
    if (result.data) {
      setView(result.data);
      setFailed(false);
    } else setFailed(true);
  }, [onSignedOut]);

  useEffect(() => {
    void load();
    // страница снова на экране (например, после бота): план и таймер перечитываются
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  /** Ответ таймера: новый таймер и, после кнопок завершения, свежий план дня. */
  const onTimer = (reply: TimerReply<Omit<TodayView, "timer" | "timerMinutes">>) => {
    setView((current) => (current ? { ...current, ...(reply.today ?? {}), timer: reply.timer } : current));
    setFailed(false);
  };

  const timerFailed = (status?: number) => {
    if (status === 401) onSignedOut();
    // таймер уже изменился (например, в боте): план и таймер перечитываются
    if (status === 400 || status === 404 || status === 409) void load();
    else setFailed(true);
  };

  /** «Таймер» у задачи; если уже идет другой таймер, показывается он и «Уже идет таймер». */
  const startTimer = async (row: PlanRow, minutes: number) => {
    const result = await api<TimerReply<never>>("POST", `/timer/start/${row.slot}/${row.position}/${minutes}`, {});
    setBusy(result.status === 409);
    if (result.data) onTimer(result.data);
    else timerFailed(result.status);
  };

  /** «Старт» у открытой награды; если уже идет другой таймер, показывается он и «Уже идет таймер». */
  const startReward = async (position: number) => {
    const result = await api<TimerReply<never>>("POST", `/timer/reward/${position}`, {});
    setBusy(result.status === 409);
    if (result.data) onTimer(result.data);
    else timerFailed(result.status);
  };

  /** Первый шаг текстом из панели «👁»: записывается в карточку задачи, план перечитывается. */
  const saveFirstStep = async (row: PlanRow, value: string) => {
    const result = await api("PATCH", `/items/${row.itemId}`, { firstStepText: value });
    if (result.status === 401) onSignedOut();
    if (result.ok) void load();
    return result.ok;
  };

  /** Действие над строкой плана; в ответе приходит свежий план («Сделано» снимает таймер задачи). */
  const run = async (slot: string, position: number, action: string, body?: unknown): Promise<boolean> => {
    const result = await api<TodayView>("POST", `/today/${slot}/${position}/${action}`, body ?? {});
    // действие могло снять таймер задачи: план и таймер перечитываются
    if (result.data && view?.timer) void load();
    if (result.status === 401) onSignedOut();
    setNotice(
      result.status === 409 ? (action === "dopamine" ? "today.noDopamine" : "today.noMore") : undefined,
    );
    if (result.data) setPlan(result.data);
    else if (result.status !== 409) setFailed(true);
    return result.ok;
  };

  /** Ответ вечернего опроса; в ответе приходит свежий план. */
  const answer = async (row: PlanRow, choice: Answer, body?: unknown): Promise<boolean> => {
    const result = await api<TodayView>("POST", `/today/survey/${row.date}/${row.slot}/${row.position}/${choice}`, body ?? {});
    if (result.status === 401) onSignedOut();
    if (result.data) {
      setPlan(result.data);
      setFailed(false);
      // ответ опроса снимает таймер задачи: план и таймер перечитываются
      if (view?.timer?.itemId === row.itemId) void load();
    } else setFailed(true);
    return result.ok;
  };

  const pick = async (itemId: string) => {
    const result = await api<TodayView>("POST", "/today/pick", { itemId });
    if (result.status === 401) onSignedOut();
    if (result.data) {
      setPlan(result.data);
      setChoosing(false);
      setNotice(undefined);
    } else if (result.status === 400) {
      // задачу не добавили (например, вчерашний опрос не пройден): день перечитывается, на странице актуальное состояние
      setChoosing(false);
      await load();
    } else setFailed(true);
  };

  if (!view) return failed ? <p role="alert">{text("error.load")}</p> : null;
  const open = view.rewards.find((reward) => reward.open);
  const empty =
    view.survey.length === 0 && view.deadlines.length === 0 && view.picked.length === 0 && Object.keys(view.buttons).length === 0;

  return (
    <section>
      {failed && <p role="alert">{text("error.generic")}</p>}
      {view.survey.length > 0 && (
        <div className="block">
          <h2>{text("survey.question")}</h2>
          {view.locked && <p className="hint">{text("survey.first")}</p>}
          <ul className="rows">
            {view.survey.map((row) => (
              <SurveyRow key={`${row.date}-${row.slot}-${row.position}`} row={row} text={text} answer={answer} />
            ))}
          </ul>
        </div>
      )}
      {!view.locked && ring && (
        <Ring done={view.done} total={view.ringTasks} label={text("today.progress", { done: view.done, total: view.ringTasks })} />
      )}
      {busy && view.timer && <p className="hint">{text("timer.busy", { title: view.timer.title })}</p>}
      {view.timer && (
        <TimerPanel<Omit<TodayView, "timer" | "timerMinutes">>
          key={`${view.timer.itemId}-${view.timer.startedAt}`}
          timer={view.timer}
          text={text}
          minutes={view.timerMinutes}
          askBlocks={workRows(view).some((row) => row.itemId === view.timer?.itemId && row.askBlocks && row.flavor !== "dopamine")}
          onReply={(reply) => {
            setBusy(false);
            onTimer(reply);
          }}
          onFailed={timerFailed}
        />
      )}
      {empty && <p className="empty">{text("list.empty")}</p>}
      {view.deadlines.length > 0 && (
        <div className="block">
          <h2>{text("today.deadlines")}</h2>
          <ul className="rows">
            {view.deadlines.map((row) => (
              <li key={row.itemId} className="row today-row">
                <span className={row.state === "done" ? "done" : undefined}>
                  {row.title}
                  {row.deadline !== null && <span className="meta">{new Date(row.deadline).toLocaleDateString(language)}</span>}
                  {row.pause && <span className="meta">{text(pauseLabels[row.pause])}</span>}
                </span>
                {row.state !== "done" && (
                  <span className="actions">
                    <button type="button" onClick={() => void run("deadline", row.position, "done")}>
                      {text("action.done")}
                    </button>
                    <TimerButton text={text} minutes={view.timerMinutes} onStart={(minutes) => void startTimer(row, minutes)} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!view.locked && <div className="block">
        <h2>{text("today.fiveTasks")}</h2>
        <Peek view={view} text={text} save={saveFirstStep} />
        <div className="slots">
          {slots.map((slot) => (
            <SlotCard
              key={slot}
              slot={slot}
              row={view.buttons[slot]}
              text={text}
              run={run}
              startTimer={startTimer}
              minutes={view.timerMinutes}
              reward={open}
              startReward={startReward}
            />
          ))}
          <button type="button" onClick={() => setChoosing(!choosing)} aria-expanded={choosing}>
            {text("slot.pick")}
          </button>
        </div>
        {notice && <p className="hint">{text(notice)}</p>}
        {view.picked.length > 0 && (
          <ul className="rows">
            {view.picked.map((row) => (
              <li key={`${row.slot}-${row.position}`} className="row today-row">
                <span className={row.state === "done" ? "done" : undefined}>{row.title}</span>
                {row.state !== "done" && (
                  <span className="actions">
                    <button type="button" onClick={() => void run(row.slot, row.position, "done")}>
                      {text("action.done")}
                    </button>
                    {row.state === "accepted" && <TimerButton text={text} minutes={view.timerMinutes} onStart={(minutes) => void startTimer(row, minutes)} />}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {choosing && <Tasks language={language} onSignedOut={onSignedOut} onPick={pick} />}
      </div>}
      {!view.locked && view.list.length > 0 && (
        <div className="block">
          <h2>{text("bot.list.title")}</h2>
          <ul className="rows">
            {view.list.map((row, index) => (
              <Fragment key={`${row.slot}-${row.position}`}>
                {view.rewards[index] && <RewardRow reward={view.rewards[index]} text={text} start={startReward} />}
                <li className="row">
                  <span className={row.state === "done" ? "done" : undefined}>
                    {row.state === "done" ? "✓" : "•"} {row.title}
                  </span>
                </li>
              </Fragment>
            ))}
            {view.rewards[view.list.length] && (
              <RewardRow reward={view.rewards[view.list.length]} text={text} start={startReward} />
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

const answerLabels: Record<Answer, TextKey> = { tomorrow: "survey.tomorrow", back: "survey.back", drop: "action.delete" };

/** Строка вечернего опроса: «На завтра», «В хранилище» (сначала «Что мешает?», если спрашивается) или «Удалить». */
function SurveyRow(props: { row: PlanRow; text: Text; answer: (row: PlanRow, choice: Answer, body?: unknown) => Promise<boolean> }) {
  const { row, text, answer } = props;
  const [asking, setAsking] = useState<Answer>();
  const [draft, setDraft] = useState("");
  const choose = (choice: Answer) => {
    if (choice !== "drop" && row.askBlocks) setAsking(choice);
    else void answer(row, choice);
  };
  return (
    <li className="row survey-row">
      <span>{row.title}</span>
      {asking ? (
        <>
          <label className="field">
            <span>{text("today.blocks")}</span>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="actions">
            <button type="button" disabled={draft.trim() === ""} onClick={() => void answer(row, asking, { blocks: draft })}>
              {text("action.save")}
            </button>
            <button type="button" onClick={() => void answer(row, asking)}>
              {text("action.skip")}
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          {(["tomorrow", "back", "drop"] as const).map((choice) => (
            <button key={choice} type="button" onClick={() => choose(choice)}>
              {text(answerLabels[choice])}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Ring(props: { done: number; total: number; label: string }) {
  const radius = 42;
  const length = 2 * Math.PI * radius;
  const share = Math.min(props.done / props.total, 1);
  return (
    <figure className="ring">
      <svg viewBox="0 0 100 100" width="120" height="120" role="img" aria-label={props.label}>
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--line)" strokeWidth="9" />
        {share > 0 && (
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${share * length} ${length}`}
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
      <figcaption>{props.label}</figcaption>
    </figure>
  );
}

type Text = (key: TextKey, params?: Record<string, string | number>) => string;
type Run = (slot: string, position: number, action: string, body?: unknown) => Promise<boolean>;

/** Строки плана, у задачи которых может идти таймер: принятые несделанные и блок дедлайнов. */
function workRows(view: TodayView): PlanRow[] {
  const rows = [...view.deadlines, ...view.picked, ...Object.values(view.buttons)];
  return rows.filter((row) => row.state === "accepted" || (row.slot === "deadline" && row.state === "offered"));
}

/** Строка награды в списке на сегодня; у открытой — «Старт». */
function RewardRow(props: { reward: ListReward; text: Text; start: (position: number) => Promise<void> }) {
  const { reward, text, start } = props;
  return (
    <li className="row reward-row">
      <span>{reward.title === null ? text("reward.hidden") : text("reward.line", { title: reward.title })}</span>
      {reward.open && reward.title !== null && (
        <span className="actions">
          <button type="button" onClick={() => void start(reward.position)}>
            {text("reward.start")}
          </button>
        </span>
      )}
    </li>
  );
}

/** «👁» над пятью кнопками: все задачи за кнопками с полем «Первый шаг»; задачи на кнопках остаются скрытыми. */
function Peek(props: { view: TodayView; text: Text; save: (row: PlanRow, value: string) => Promise<boolean> }) {
  const { view, text, save } = props;
  const [open, setOpen] = useState(false);
  const rows = slots.flatMap((slot) => {
    const row = view.buttons[slot];
    return row && (row.state === "offered" || row.state === "accepted") ? [{ slot, row }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div className="peek">
      <button type="button" className="peek-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={text("today.peek")} title={text("today.peek")}>
        👁
      </button>
      {open && (
        <div className="block">
          <h3>{text("today.peek")}</h3>
          <ul className="rows">
            {rows.map(({ slot, row }) => (
              <li key={slot} className="row peek-row">
                <span className="slot-name">{text(slotLabels[slot])}</span>
                <strong>{row.title}</strong>
                {row.hasVoice && <p className="hint">{text("today.voiceStep")}</p>}
                <TextField label={text("field.firstStep")} value={row.firstStep ?? ""} multiline onCommit={(value) => save(row, value)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SlotCard(props: {
  slot: Slot;
  row?: PlanRow;
  text: Text;
  run: Run;
  startTimer: (row: PlanRow, minutes: number) => Promise<void>;
  minutes: number[];
  /** Открытая награда списка на сегодня (для «Награда» после «Сделано»). */
  reward?: ListReward;
  startReward: (position: number) => Promise<void>;
}) {
  const { slot, row, text, run, startTimer, minutes, reward, startReward } = props;
  const [step, setStep] = useState<Step>();
  const [showReward, setShowReward] = useState(false);
  const label = text(slotLabels[slot]);
  if (!row) return <button type="button" disabled>{label}</button>;
  const go = (action: string, body?: unknown) => run(slot, row.position, action, body);

  if (row.hidden) {
    return (
      <button type="button" onClick={() => void go("reveal")}>
        {label}
      </button>
    );
  }

  const dopamine = row.flavor === "dopamine";
  const task = (
    <div className="slot-task">
      <span className="slot-name">{label}</span>
      <strong>{row.title}</strong>
      <span className="meta">{text(levelLabels[row.level])}</span>
      {row.firstStep && <p className="hint">{row.firstStep}</p>}
      {row.hasVoice && <p className="hint">{text("today.voiceStep")}</p>}
    </div>
  );

  if (row.state === "offered") {
    return (
      <div className="slot-card">
        {task}
        <div className="actions">
          <button type="button" className="primary" onClick={() => void go("accept")}>
            {text("action.accept")}
          </button>
          {dopamine ? (
            <button type="button" onClick={() => void go("release")}>
              {text("action.skip")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                void go("refuse").then((ok) => ok && setStep(row.reasonPrompt ? "why" : "blocks"))
              }
            >
              {text("action.refuse")}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (row.state === "accepted") {
    return (
      <div className="slot-card">
        {task}
        <div className="actions">
          <button type="button" className="primary" onClick={() => void go("done")}>
            {text("action.done")}
          </button>
          {dopamine && (
            <button type="button" onClick={() => void go("release")}>
              {text("action.close")}
            </button>
          )}
          <TimerButton text={text} minutes={minutes} onStart={(length) => void startTimer(row, length)} />
        </div>
      </div>
    );
  }

  if (row.state === "refused") {
    return (
      <Refusal label={label} row={row} step={step ?? (row.reasonPrompt ? "why" : "blocks")} setStep={setStep} text={text} go={go} />
    );
  }

  if (row.state === "done" || (row.state === "closed" && dopamine)) {
    return (
      <div className="slot-card">
        <span className="slot-name">{label}</span>
        {showReward && reward?.title && (
          <p>
            {text("reward.line", { title: reward.title })}{" "}
            <button type="button" onClick={() => void startReward(reward.position)}>
              {text("reward.start")}
            </button>
          </p>
        )}
        <div className="actions">
          {reward?.title && (
            <button type="button" onClick={() => setShowReward(!showReward)} aria-expanded={showReward}>
              {text("action.reward")}
            </button>
          )}
          <button type="button" onClick={() => void go("dopamine")}>
            {text("action.dopamine")}
          </button>
          <button type="button" onClick={() => void go("refresh")}>
            {text("action.refresh")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="slot-card">
      <span className="slot-name">{label}</span>
      <p className="hint">{text("today.noMore")}</p>
    </div>
  );
}

function Refusal(props: {
  label: string;
  row: PlanRow;
  step: Step;
  setStep: (step: Step) => void;
  text: Text;
  go: (action: string, body?: unknown) => Promise<boolean>;
}) {
  const { label, row, step, setStep, text, go } = props;
  const [draft, setDraft] = useState("");
  const skip = !row.askBlocks && step === "blocks";

  useEffect(() => {
    if (skip) void go("next");
  }, [skip]); // eslint-disable-line react-hooks/exhaustive-deps

  if (skip) return null;
  return (
    <div className="slot-card">
      <span className="slot-name">{label}</span>
      <strong>{row.title}</strong>
      {step === "why" && (
        <>
          <p>{text("today.why", { why: row.reasonPrompt ?? "" })}</p>
          <div className="actions">
            <button type="button" onClick={() => void go("accept")}>
              {text("action.takeAnyway")}
            </button>
            <button type="button" onClick={() => setStep("write")}>
              {text("action.writeReason")}
            </button>
          </div>
        </>
      )}
      {step === "write" && (
        <>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={text("field.refusalNote")} />
          <button
            type="button"
            disabled={draft.trim() === ""}
            onClick={() =>
              void go("reason", { text: draft }).then((ok) => {
                if (!ok) return;
                setDraft("");
                setStep("blocks");
              })
            }
          >
            {text("action.writeReason")}
          </button>
        </>
      )}
      {step === "blocks" && (
        <>
          <label className="field">
            <span>{text("today.blocks")}</span>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="actions">
            <button type="button" disabled={draft.trim() === ""} onClick={() => void go("next", { blocks: draft })}>
              {text("action.save")}
            </button>
            <button type="button" onClick={() => void go("next")}>
              {text("action.skip")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
