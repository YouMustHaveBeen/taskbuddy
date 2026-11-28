import { useCallback, useEffect, useState } from "react";
import { t, type Language, type TextKey } from "../../i18n";
import { api } from "./api";
import { Tasks } from "./Tasks";

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
  reasonPrompt: string | null;
  askBlocks: boolean;
};
type TodayView = {
  deadlines: PlanRow[];
  buttons: Partial<Record<Slot, PlanRow>>;
  picked: PlanRow[];
  survey: PlanRow[];
  locked: boolean;
  done: number;
  ringTasks: number;
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
  }, [load]);

  /** Действие над строкой плана; в ответе приходит свежий план. */
  const run = async (slot: string, position: number, action: string, body?: unknown): Promise<boolean> => {
    const result = await api<TodayView>("POST", `/today/${slot}/${position}/${action}`, body ?? {});
    if (result.status === 401) onSignedOut();
    setNotice(
      result.status === 409 ? (action === "dopamine" ? "today.noDopamine" : "today.noMore") : undefined,
    );
    if (result.data) setView(result.data);
    else if (result.status !== 409) setFailed(true);
    return result.ok;
  };

  /** Ответ вечернего опроса; в ответе приходит свежий план. */
  const answer = async (row: PlanRow, choice: Answer, body?: unknown): Promise<boolean> => {
    const result = await api<TodayView>("POST", `/today/survey/${row.date}/${row.slot}/${row.position}/${choice}`, body ?? {});
    if (result.status === 401) onSignedOut();
    if (result.data) {
      setView(result.data);
      setFailed(false);
    } else setFailed(true);
    return result.ok;
  };

  const pick = async (itemId: string) => {
    const result = await api<TodayView>("POST", "/today/pick", { itemId });
    if (result.status === 401) onSignedOut();
    if (result.data) {
      setView(result.data);
      setChoosing(false);
      setNotice(undefined);
    } else if (result.status === 400) {
      // задачу не добавили (например, вчерашний опрос не пройден): день перечитывается, на странице актуальное состояние
      setChoosing(false);
      await load();
    } else setFailed(true);
  };

  if (!view) return failed ? <p role="alert">{text("error.load")}</p> : null;
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
                  <button type="button" onClick={() => void run("deadline", row.position, "done")}>
                    {text("action.done")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!view.locked && <div className="block">
        <h2>{text("today.fiveTasks")}</h2>
        <div className="slots">
          {slots.map((slot) => (
            <SlotCard key={slot} slot={slot} row={view.buttons[slot]} text={text} run={run} />
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
                  <button type="button" onClick={() => void run(row.slot, row.position, "done")}>
                    {text("action.done")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {choosing && <Tasks language={language} onSignedOut={onSignedOut} onPick={pick} />}
      </div>}
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

function SlotCard(props: { slot: Slot; row?: PlanRow; text: Text; run: Run }) {
  const { slot, row, text, run } = props;
  const [step, setStep] = useState<Step>();
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
        <div className="actions">
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
