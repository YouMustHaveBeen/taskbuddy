import { useCallback, useEffect, useState } from "react";
import { t, type Language, type TextKey } from "../../i18n";
import { api } from "./api";

type NameRow = { id: string; name: string };
type Reward = { id: string; title: string; minutes: number };
type Pair = { categoryA: string; categoryB: string };
type Lists = {
  spheres: NameRow[];
  actionKinds: NameRow[];
  categories: NameRow[];
  rewards: Reward[];
  compat: Pair[];
};

type Props = { language: Language; onSignedOut: () => void };
type Run = (method: string, path: string, body?: unknown) => Promise<boolean>;
type Text = (key: TextKey) => string;

const errorKeys: Record<string, TextKey> = {
  duplicate: "error.duplicate",
  in_use: "error.in_use",
  invalid: "error.invalid",
};

export function References({ language, onSignedOut }: Props) {
  const [lists, setLists] = useState<Lists>();
  const [error, setError] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    const result = await api<Lists>("GET", "/references");
    if (result.status === 401) onSignedOut();
    if (result.data) {
      setLists(result.data);
      setLoadFailed(false);
    } else if (result.status !== 401) setLoadFailed(true);
  }, [onSignedOut]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback<Run>(
    async (method, path, body) => {
      const result = await api(method, path, body);
      if (result.status === 401) onSignedOut();
      setError(result.ok ? undefined : (result.error ?? "generic"));
      await reload();
      return result.ok;
    },
    [reload, onSignedOut],
  );

  const text: Text = (key) => t(language, key);
  if (!lists) return loadFailed ? <p role="alert">{text("error.load")}</p> : null;

  return (
    <div>
      {error && <p role="alert">{text(errorKeys[error] ?? "error.generic")}</p>}
      <NameSection title={text("references.areas")} path="spheres" rows={lists.spheres} run={run} text={text} />
      <NameSection title={text("references.kinds")} path="action-kinds" rows={lists.actionKinds} run={run} text={text} />
      <NameSection title={text("references.categories")} path="categories" rows={lists.categories} run={run} text={text} />
      <RewardSection rows={lists.rewards} run={run} text={text} />
      <ParallelSection categories={lists.categories} pairs={lists.compat} run={run} text={text} />
    </div>
  );
}

function EditableField(props: {
  label: string;
  value: string;
  type?: "text" | "number";
  onCommit: (value: string) => Promise<boolean>;
}) {
  const { label, value, type = "text", onCommit } = props;
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={label}
      type={type}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === value) return;
        void onCommit(draft).then((ok) => {
          if (!ok) setDraft((current) => (current === draft ? value : current));
        });
      }}
    />
  );
}

function NameSection(props: { title: string; path: string; rows: NameRow[]; run: Run; text: Text }) {
  const { title, path, rows, run, text } = props;
  const [draft, setDraft] = useState("");
  return (
    <section>
      <h2>{title}</h2>
      {rows.length === 0 && <p>{text("list.empty")}</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <EditableField
              label={text("field.name")}
              value={row.name}
              onCommit={(name) => run("PATCH", `/references/${path}/${row.id}`, { name })}
            />
            <button type="button" onClick={() => void run("DELETE", `/references/${path}/${row.id}`)}>
              {text("action.delete")}
            </button>
          </li>
        ))}
      </ul>
      <input
        aria-label={text("field.name")}
        placeholder={text("field.name")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        onClick={() =>
          void run("POST", `/references/${path}`, { name: draft }).then((ok) => ok && setDraft(""))
        }
      >
        {text("action.add")}
      </button>
    </section>
  );
}

function RewardSection(props: { rows: Reward[]; run: Run; text: Text }) {
  const { rows, run, text } = props;
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState("");
  return (
    <section>
      <h2>{text("references.rewards")}</h2>
      {rows.length === 0 && <p>{text("list.empty")}</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <EditableField
              label={text("field.name")}
              value={row.title}
              onCommit={(value) => run("PATCH", `/references/rewards/${row.id}`, { title: value })}
            />
            <EditableField
              label={text("field.minutes")}
              type="number"
              value={String(row.minutes)}
              onCommit={(value) => run("PATCH", `/references/rewards/${row.id}`, { minutes: Number(value) })}
            />
            <button type="button" onClick={() => void run("DELETE", `/references/rewards/${row.id}`)}>
              {text("action.delete")}
            </button>
          </li>
        ))}
      </ul>
      <input
        aria-label={text("field.name")}
        placeholder={text("field.name")}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        aria-label={text("field.minutes")}
        placeholder={text("field.minutes")}
        type="number"
        value={minutes}
        onChange={(event) => setMinutes(event.target.value)}
      />
      <button
        type="button"
        onClick={() =>
          void run("POST", "/references/rewards", minutes ? { title, minutes: Number(minutes) } : { title }).then(
            (ok) => {
              if (!ok) return;
              setTitle("");
              setMinutes("");
            },
          )
        }
      >
        {text("action.add")}
      </button>
    </section>
  );
}

function ParallelSection(props: { categories: NameRow[]; pairs: Pair[]; run: Run; text: Text }) {
  const { categories, pairs, run, text } = props;
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const name = (id: string) => categories.find((row) => row.id === id)?.name ?? "";
  const options = (value: string, onChange: (value: string) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" />
      {categories.map((row) => (
        <option key={row.id} value={row.id}>
          {row.name}
        </option>
      ))}
    </select>
  );
  return (
    <section>
      <h2>{text("references.parallel")}</h2>
      {pairs.length === 0 && <p>{text("list.empty")}</p>}
      <ul>
        {pairs.map((pair) => (
          <li key={`${pair.categoryA}-${pair.categoryB}`}>
            {name(pair.categoryA)} + {name(pair.categoryB)}
            <button
              type="button"
              onClick={() => void run("DELETE", "/references/compat", { a: pair.categoryA, b: pair.categoryB })}
            >
              {text("action.delete")}
            </button>
          </li>
        ))}
      </ul>
      {options(first, setFirst, text("field.firstCategory"))}
      {options(second, setSecond, text("field.secondCategory"))}
      <button
        type="button"
        onClick={() =>
          void run("POST", "/references/compat", { a: first, b: second }).then((ok) => {
            if (!ok) return;
            setFirst("");
            setSecond("");
          })
        }
      >
        {text("action.add")}
      </button>
    </section>
  );
}
