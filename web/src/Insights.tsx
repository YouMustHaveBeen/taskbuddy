import { useCallback, useEffect, useRef, useState } from "react";
import { defaults } from "../../src/core/settings";
import { t, type Language, type TextKey } from "../../i18n";
import { api } from "./api";

type Insight = { id: string; text: string; sphereIds: string[] };
type NameRow = { id: string; name: string };
type Props = { language: Language; onSignedOut: () => void };

/** Вкладка «Инсайты»: ответы «Что мешает?», новые сверху; текст и сферы правятся сразу, удаление с подтверждением. */
export function Insights({ language, onSignedOut }: Props) {
  const text = (key: TextKey) => t(language, key);
  const [rows, setRows] = useState<Insight[]>();
  const [spheres, setSpheres] = useState<NameRow[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [list, references] = await Promise.all([
      api<{ insights: Insight[] }>("GET", "/insights"),
      api<{ spheres: NameRow[] }>("GET", "/references"),
    ]);
    if (list.status === 401 || references.status === 401) onSignedOut();
    if (list.data && references.data) {
      setRows(list.data.insights);
      setSpheres(references.data.spheres);
    }
    // вкладка показывается, только когда загружены и инсайты, и сферы
    setFailed(!list.data || !references.data);
  }, [onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (id: string, patch: { text?: string; sphereIds?: string[] }) => {
    const result = await api<{ insight: Insight }>("PATCH", `/insights/${id}`, patch);
    if (result.status === 401) onSignedOut();
    const insight = result.data?.insight;
    if (insight) setRows((current) => current?.map((row) => (row.id === id ? insight : row)));
    setFailed(!insight);
    return insight !== undefined;
  };

  const remove = async (id: string) => {
    const result = await api("DELETE", `/insights/${id}`);
    if (result.status === 401) onSignedOut();
    if (result.ok) setRows((current) => current?.filter((row) => row.id !== id));
    setFailed(!result.ok);
  };

  if (!rows) return failed ? <p role="alert">{text("error.load")}</p> : null;
  return (
    <section>
      {failed && <p role="alert">{text("error.generic")}</p>}
      {rows.length === 0 && <p className="empty">{text("insights.empty")}</p>}
      <ul className="rows">
        {rows.map((row) => (
          <InsightRow key={row.id} row={row} spheres={spheres} text={text} save={save} remove={remove} />
        ))}
      </ul>
    </section>
  );
}

function InsightRow(props: {
  row: Insight;
  spheres: NameRow[];
  text: (key: TextKey) => string;
  save: (id: string, patch: { text?: string; sphereIds?: string[] }) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}) {
  const { row, spheres, text, save, remove } = props;
  const [draft, setDraft] = useState(row.text);
  const [confirming, setConfirming] = useState(false);
  // последний набранный текст, последний сохраненный текст и последний выбор сфер
  const latestText = useRef(row.text);
  const savedText = useRef(row.text);
  const latestSpheres = useRef(row.sphereIds);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // сохранения одной записи уходят по очереди: следующее начинается после ответа на предыдущее
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = (patch: { text?: string; sphereIds?: string[] }) => {
    const next = queue.current.then(() => save(row.id, patch));
    queue.current = next;
    return next;
  };

  const saveText = () => {
    clearTimeout(timer.current);
    const value = latestText.current.trim();
    if (value === "" || value === savedText.current) return;
    void enqueue({ text: value }).then((ok) => {
      if (ok) savedText.current = value;
    });
  };

  // текст сохраняется после паузы в наборе, при выходе из поля и при закрытии вкладки
  useEffect(() => saveText, []);

  const toggle = (sphereId: string, checked: boolean) => {
    const next = checked ? [...latestSpheres.current, sphereId] : latestSpheres.current.filter((other) => other !== sphereId);
    if (next.length > defaults.itemMaxSpheres) return;
    const previous = latestSpheres.current;
    latestSpheres.current = next;
    void enqueue({ sphereIds: next }).then((ok) => {
      if (!ok && latestSpheres.current === next) latestSpheres.current = previous;
    });
  };

  return (
    <li className="row insight-row">
      <textarea
        aria-label={text("tab.insights")}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          latestText.current = event.target.value;
          clearTimeout(timer.current);
          timer.current = setTimeout(saveText, defaults.typingSaveMs);
        }}
        onBlur={() => {
          saveText();
          if (latestText.current.trim() === "") {
            setDraft(savedText.current);
            latestText.current = savedText.current;
          }
        }}
      />
      <fieldset className="spheres">
        <legend>{text("field.spheres")}</legend>
        {spheres.map((sphere) => (
          <label key={sphere.id}>
            <input
              type="checkbox"
              checked={row.sphereIds.includes(sphere.id)}
              disabled={!row.sphereIds.includes(sphere.id) && row.sphereIds.length >= defaults.itemMaxSpheres}
              onChange={(event) => toggle(sphere.id, event.target.checked)}
            />
            {sphere.name}
          </label>
        ))}
      </fieldset>
      {confirming ? (
        <div className="actions">
          <button type="button" onClick={() => void remove(row.id)}>
            {text("action.confirmDelete")}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            {text("action.cancel")}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          {text("action.delete")}
        </button>
      )}
    </li>
  );
}
