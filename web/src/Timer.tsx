import { useEffect, useRef, useState } from "react";
import type { TextKey } from "../../i18n";
import { api } from "./api";

export type TimerView = {
  kind: "task" | "zone" | "reward";
  itemId: string;
  title: string;
  minutes: number;
  startedAt: number;
  remainingSec: number | null;
  endsAt: number | null;
  startedIn: "bot" | "web";
  botMessageId: number | null;
  state: "running" | "paused" | "ended";
};

type Text = (key: TextKey, params?: Record<string, string | number>) => string;
/** Ответ запросов таймера: таймер и, после кнопок завершения, план дня. */
export type TimerReply<Today> = { timer: TimerView | null; today?: Today };

/** Короткий звук в конце таймера. */
function beep() {
  try {
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 1.2);
    tone.connect(gain).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + 1.2);
    tone.onended = () => void audio.close();
  } catch {
    // звук недоступен: таймер все равно показывает «Время вышло»
  }
}

const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

/** Кнопки длины таймера. */
export function Lengths(props: { text: Text; minutes: number[]; onPick: (minutes: number) => void }) {
  return (
    <div className="actions">
      {props.minutes.map((minutes) => (
        <button key={minutes} type="button" onClick={() => props.onPick(minutes)}>
          {props.text("timer.minutes", { count: minutes })}
        </button>
      ))}
    </div>
  );
}

/** «Таймер» у задачи: по нажатию — кнопки длины. */
export function TimerButton(props: { text: Text; minutes: number[]; onStart: (minutes: number) => void }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <Lengths
        text={props.text}
        minutes={props.minutes}
        onPick={(minutes) => {
          setOpen(false);
          props.onStart(minutes);
        }}
      />
    );
  }
  return (
    <button type="button" onClick={() => setOpen(true)}>
      {props.text("action.timer")}
    </button>
  );
}

type PanelProps<Today> = {
  timer: TimerView;
  text: Text;
  /** Длины таймера (настройка timerMinutes). */
  minutes: number[];
  /** Спросить «Что мешает?» перед «Вернуть». */
  askBlocks: boolean;
  onReply: (reply: TimerReply<Today>) => void;
  onFailed: (status?: number) => void;
};

/** Таймер над «Пять задач»: отсчет мм:сс, «Пауза», «Стоп», «Парковка»; после остановки — четыре кнопки. */
export function TimerPanel<Today>({ timer, text, minutes, askBlocks, onReply, onFailed }: PanelProps<Today>) {
  const [now, setNow] = useState(() => Date.now());
  const [step, setStep] = useState<"park" | "again" | "back">();
  const [draft, setDraft] = useState("");
  const [parked, setParked] = useState(false);
  const [parking, setParking] = useState(false);
  const rang = useRef<number | null>(null);

  const running = timer.state === "running" && timer.endsAt !== null;
  const left = running ? Math.max(0, Math.ceil(((timer.endsAt ?? 0) - now) / 1000)) : (timer.remainingSec ?? 0);
  const ended = timer.state === "ended" || (running && left === 0);

  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);

  // звук один раз на окончание этого таймера
  useEffect(() => {
    if (running && left === 0 && rang.current !== timer.endsAt) {
      rang.current = timer.endsAt;
      beep();
    }
  }, [running, left, timer.endsAt]);

  const send = async (path: string, body?: unknown, keepStep = false) => {
    const result = await api<TimerReply<Today>>("POST", `/timer/${path}`, body ?? {});
    if (result.data) {
      onReply(result.data);
      if (!keepStep) {
        setStep(undefined);
        setDraft("");
      }
    } else onFailed(result.status);
    return result.ok;
  };

  /** Кнопки завершения снимают таймер со страницы, в ответе — свежий план дня. */
  const close = async (action: "finish" | "later" | "back", body?: unknown) => {
    const result = await api<TimerReply<Today>>("POST", `/timer/${action}`, body ?? {});
    if (result.data) onReply({ timer: null, today: result.data.today });
    else onFailed(result.status);
  };

  const park = async () => {
    setParking(true);
    const result = await api("POST", "/timer/park", { text: draft });
    setParking(false);
    if (!result.ok) {
      onFailed(result.status);
      return;
    }
    setDraft("");
    setStep(undefined);
    setParked(true);
  };

  return (
    <div className="block timer">
      <p aria-live="polite">{ended ? text("timer.ended", { title: timer.title }) : ""}</p>
      {!ended && (
        <p className="timer-clock" role="timer">
          <strong>{timer.title}</strong>{" "}
          {clock(left)}
          {timer.state === "paused" && <span className="meta">{text("timer.pausedLabel")}</span>}
        </p>
      )}
      {!ended && (
        <div className="actions">
          {timer.state === "running" ? (
            <button type="button" onClick={() => void send("pause")}>
              {text("timer.pause")}
            </button>
          ) : (
            <button type="button" onClick={() => void send("resume")}>
              {text("timer.resume")}
            </button>
          )}
          <button type="button" onClick={() => void send("stop")}>
            {text("timer.stop")}
          </button>
          {timer.kind === "task" && (
            <button type="button" onClick={() => setStep(step === "park" ? undefined : "park")} aria-expanded={step === "park"}>
              {text("timer.park")}
            </button>
          )}
        </div>
      )}
      {!ended && step === "park" && (
        <>
          <label className="field">
            <span>{text("timer.thought")}</span>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <button type="button" disabled={parking || draft.trim() === ""} onClick={() => void park()}>
            {text("action.save")}
          </button>
        </>
      )}
      {!ended && parked && step !== "park" && <p className="hint">👍</p>}
      {ended && (step === undefined || step === "park") && (
        <div className="actions">
          <button type="button" className="primary" onClick={() => void close("finish")}>
            {text("timer.finish")}
          </button>
          <button type="button" onClick={() => setStep("again")}>
            {text("timer.again")}
          </button>
          <button type="button" onClick={() => void close("later")}>
            {text("timer.later")}
          </button>
          <button type="button" onClick={() => (askBlocks ? setStep("back") : void close("back"))}>
            {text("timer.return")}
          </button>
        </div>
      )}
      {ended && step === "again" && <Lengths text={text} minutes={minutes} onPick={(length) => void send(`again/${length}`)} />}
      {ended && step === "back" && (
        <>
          <label className="field">
            <span>{text("today.blocks")}</span>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="actions">
            <button type="button" disabled={draft.trim() === ""} onClick={() => void close("back", { blocks: draft })}>
              {text("action.save")}
            </button>
            <button type="button" onClick={() => void close("back")}>
              {text("action.skip")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
