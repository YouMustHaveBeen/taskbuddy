import { useCallback, useEffect, useState } from "react";
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
    if (list.data) setRows(list.data.insights);
    if (references.data) setSpheres(references.data.spheres);
    setFailed(!list.data);
  }, [onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (id: string, patch: { text?: string; sphereIds?: string[] }) => {
    const result = await api<{ insight: Insight }>("PATCH", `/insights/${id}`, patch);
    if (result.status === 401) onSignedOut();
    const insight = result.data?.insight;
    if (insight) setRows((current) => current?.map((row) => (row.id === id ? insight : row)));
    else setFailed(true);
  };

  const remove = async (id: string) => {
    const result = await api("DELETE", `/insights/${id}`);
    if (result.status === 401) onSignedOut();
    if (result.ok) setRows((current) => current?.filter((row) => row.id !== id));
    else setFailed(true);
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
  save: (id: string, patch: { text?: string; sphereIds?: string[] }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}) {
  const { row, spheres, text, save, remove } = props;
  const [draft, setDraft] = useState(row.text);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="row insight-row">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== "" && draft.trim() !== row.text) void save(row.id, { text: draft });
          else setDraft(row.text);
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
              onChange={(event) =>
                void save(row.id, {
                  sphereIds: event.target.checked
                    ? [...row.sphereIds, sphere.id]
                    : row.sphereIds.filter((other) => other !== sphere.id),
                })
              }
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
