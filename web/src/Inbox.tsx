import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t, type Language, type TextKey } from "../../i18n";
import { defaults } from "../../src/core/settings";
import { api } from "./api";

type Row = { id: string; title: string };
type NameRow = { id: string; name: string };
type Lists = { spheres: NameRow[]; actionKinds: NameRow[]; categories: NameRow[] };
type Card = {
  id: string;
  kind: string;
  title: string;
  important: boolean | null;
  urgent: boolean | null;
  impactful: boolean | null;
  easy: boolean | null;
  why: string | null;
  sphereIds: string[];
  actionKindId: string | null;
  categoryId: string | null;
  deadline: number | null;
  remindAt: number | null;
  projectId: string | null;
  isProject: boolean;
  deferred: boolean;
  deferredUntil: number | null;
  queued: boolean;
  waitingFor: string | null;
  flavor: "dopamine" | "frog" | null;
  firstStepText: string | null;
};
type Save = (patch: Record<string, unknown>) => Promise<boolean>;
type Text = (key: TextKey) => string;
type Props = { language: Language; onSignedOut: () => void };

const two = (n: number) => String(n).padStart(2, "0");

function dateValue(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function dateTimeValue(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  return `${dateValue(ms)}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

function fromDate(value: string): number | null {
  const [y, m, d] = value.split("-").map(Number);
  return value ? new Date(y, m - 1, d).getTime() : null;
}

function fromDateTime(value: string): number | null {
  return value ? new Date(value).getTime() : null;
}

export function Inbox({ language, onSignedOut }: Props) {
  const text: Text = (key) => t(language, key);
  const [rows, setRows] = useState<Row[]>();
  const [lists, setLists] = useState<Lists>();
  const [projects, setProjects] = useState<Row[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const [inbox, references, projectList] = await Promise.all([
      api<{ items: Row[] }>("GET", "/inbox"),
      api<Lists>("GET", "/references"),
      api<{ projects: Row[] }>("GET", "/projects"),
    ]);
    const signedOut = [inbox, references, projectList].some((result) => result.status === 401);
    if (signedOut) onSignedOut();
    if (inbox.data && references.data && projectList.data) {
      setRows(inbox.data.items);
      setLists(references.data);
      setProjects(projectList.data.projects);
      setFailed(false);
    } else if (!signedOut) setFailed(true);
  }, [onSignedOut]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const creating = useRef(false);

  const create = async () => {
    const title = newTitle.trim();
    if (!title || creating.current) return;
    creating.current = true;
    const result = await api<{ id: string }>("POST", "/inbox", { title });
    creating.current = false;
    if (result.status === 401) onSignedOut();
    if (!result.data) return;
    setNewTitle("");
    setAdding(false);
    setOpenId(result.data.id);
    await reload();
  };

  const remove = async (id: string) => {
    const result = await api("DELETE", `/items/${id}`);
    if (result.status === 401) onSignedOut();
    if (openId === id) setOpenId(undefined);
    await reload();
  };

  if (!rows || !lists) return failed ? <p role="alert">{text("error.load")}</p> : null;

  return (
    <section>
      <button type="button" aria-label={text("action.new")} onClick={() => setAdding(!adding)}>
        +
      </button>
      {adding && (
        <input
          aria-label={text("field.name")}
          value={newTitle}
          autoFocus
          onChange={(event) => setNewTitle(event.target.value)}
          onBlur={() => void create()}
          onKeyDown={(event) => event.key === "Enter" && void create()}
        />
      )}
      {rows.length === 0 && <p>{text("list.empty")}</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            {row.title}
            <button
              type="button"
              onClick={() => {
                if (openId === row.id) void reload();
                setOpenId(openId === row.id ? undefined : row.id);
              }}
            >
              {text(openId === row.id ? "action.close" : "action.open")}
            </button>
            <button type="button" onClick={() => void remove(row.id)}>
              {text("action.delete")}
            </button>
            {openId === row.id && (
              <CardForm
                id={row.id}
                text={text}
                lists={lists}
                projects={projects}
                onSignedOut={onSignedOut}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CardForm(props: {
  id: string;
  text: Text;
  lists: Lists;
  projects: Row[];
  onSignedOut: () => void;
}) {
  const { id, text, lists, projects, onSignedOut } = props;
  const [card, setCard] = useState<Card>();
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [spheres, setSpheres] = useState<string[]>([]);
  const latestSpheres = useRef<string[]>([]);

  useEffect(() => {
    void api<{ card: Card }>("GET", `/items/${id}`).then((result) => {
      if (result.status === 401) onSignedOut();
      if (result.data) {
        setCard(result.data.card);
        setSpheres(result.data.card.sphereIds);
        latestSpheres.current = result.data.card.sphereIds;
      } else setFailed(true);
    });
  }, [id, onSignedOut]);

  const save: Save = async (patch) => {
    const result = await api<{ card: Card }>("PATCH", `/items/${id}`, patch);
    if (result.status === 401) onSignedOut();
    setSaveFailed(!result.data);
    if (!result.data) return false;
    setCard(result.data.card);
    return true;
  };

  if (!card) return failed ? <p role="alert">{text("error.load")}</p> : null;
  const projectOptions = projects.filter((project) => project.id !== id);

  return (
    <div>
      {saveFailed && <p role="alert">{text("error.generic")}</p>}
      <p>{text(card.kind === "task" ? "card.task" : "card.draft")}</p>
      <TextField label={text("field.name")} value={card.title} onCommit={(v) => save({ title: v })} />
      <Mark label={text("field.important")} value={card.important} text={text} onChange={(v) => save({ important: v })} />
      <Mark label={text("field.urgent")} value={card.urgent} text={text} onChange={(v) => save({ urgent: v })} />
      <Mark label={text("field.impactful")} value={card.impactful} text={text} onChange={(v) => save({ impactful: v })} />
      <Mark label={text("field.easy")} value={card.easy} text={text} onChange={(v) => save({ easy: v })} />
      <TextField label={text("field.why")} value={card.why ?? ""} onCommit={(v) => save({ why: v })} />
      <fieldset>
        <legend>{text("field.spheres")}</legend>
        {lists.spheres.map((sphere) => (
          <label key={sphere.id}>
            <input
              type="checkbox"
              checked={spheres.includes(sphere.id)}
              disabled={!spheres.includes(sphere.id) && spheres.length >= defaults.itemMaxSpheres}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...latestSpheres.current, sphere.id]
                  : latestSpheres.current.filter((other) => other !== sphere.id);
                latestSpheres.current = next;
                setSpheres(next);
                void save({ sphereIds: next }).then((ok) => {
                  if (ok) return;
                  latestSpheres.current = card.sphereIds;
                  setSpheres(card.sphereIds);
                });
              }}
            />
            {sphere.name}
          </label>
        ))}
      </fieldset>
      <Choice label={text("field.kind")} value={card.actionKindId} options={lists.actionKinds} onChange={(v) => save({ actionKindId: v })} />
      <Choice label={text("field.category")} value={card.categoryId} options={lists.categories} onChange={(v) => save({ categoryId: v })} />
      <Labeled label={text("field.deadline")}>
        <input type="date" value={dateValue(card.deadline)} onChange={(e) => void save({ deadline: fromDate(e.target.value) })} />
      </Labeled>
      <Labeled label={text("field.remindAt")}>
        <input type="datetime-local" value={dateTimeValue(card.remindAt)} onChange={(e) => void save({ remindAt: fromDateTime(e.target.value) })} />
      </Labeled>
      <Choice label={text("field.project")} value={card.projectId} options={projectOptions.map((p) => ({ id: p.id, name: p.title }))} onChange={(v) => save({ projectId: v })} />
      <Check label={text("field.isProject")} value={card.isProject} onChange={(v) => save({ isProject: v })} />
      <Check label={text("field.deferred")} value={card.deferred} onChange={(v) => save({ deferred: v })} />
      <Labeled label={text("field.deferredUntil")}>
        <input type="date" value={dateValue(card.deferredUntil)} onChange={(e) => void save({ deferredUntil: fromDate(e.target.value) })} />
      </Labeled>
      <Check label={text("field.queued")} value={card.queued} onChange={(v) => save({ queued: v })} />
      <TextField label={text("field.waitingFor")} value={card.waitingFor ?? ""} onCommit={(v) => save({ waitingFor: v })} />
      <Labeled label={text("field.flavor")}>
        <select value={card.flavor ?? ""} onChange={(e) => void save({ flavor: e.target.value || null })}>
          <option value="" />
          <option value="dopamine">{text("flavor.dopamine")}</option>
          <option value="frog">{text("flavor.frog")}</option>
        </select>
      </Labeled>
      <TextField label={text("field.firstStep")} value={card.firstStepText ?? ""} onCommit={(v) => save({ firstStepText: v })} />
    </div>
  );
}

function Labeled(props: { label: string; children: ReactNode }) {
  return (
    <label>
      {props.label} {props.children}
    </label>
  );
}

function TextField(props: { label: string; value: string; onCommit: (value: string) => Promise<boolean> }) {
  const { label, value, onCommit } = props;
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <Labeled label={label}>
      <input
        value={draft}
        onFocus={() => (editing.current = true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          editing.current = false;
          if (draft === value) return;
          void onCommit(draft).then((ok) => {
            if (!ok) setDraft((current) => (current === draft ? value : current));
          });
        }}
      />
    </Labeled>
  );
}

function Mark(props: { label: string; value: boolean | null; text: Text; onChange: (value: boolean | null) => Promise<boolean> }) {
  const { label, value, text, onChange } = props;
  const current = value === null ? "" : value ? "yes" : "no";
  return (
    <Labeled label={label}>
      <select value={current} onChange={(e) => void onChange(e.target.value === "" ? null : e.target.value === "yes")}>
        <option value="">{text("value.unset")}</option>
        <option value="yes">{text("value.yes")}</option>
        <option value="no">{text("value.no")}</option>
      </select>
    </Labeled>
  );
}

function Choice(props: { label: string; value: string | null; options: NameRow[]; onChange: (value: string | null) => Promise<boolean> }) {
  const { label, value, options, onChange } = props;
  return (
    <Labeled label={label}>
      <select value={value ?? ""} onChange={(e) => void onChange(e.target.value || null)}>
        <option value="" />
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Labeled>
  );
}

function Check(props: { label: string; value: boolean; onChange: (value: boolean) => Promise<boolean> }) {
  return (
    <label>
      <input type="checkbox" checked={props.value} onChange={(e) => void props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}
