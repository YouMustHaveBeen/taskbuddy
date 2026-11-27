import { useCallback, useEffect, useState } from "react";
import { t, type Language, type TextKey } from "../../i18n";
import { api } from "./api";
import { CardForm, Labeled, type Lists, type NameRow, type Row, type Text } from "./Inbox";

type Level = "top" | "high" | "medium" | "low" | "none";
type Mark = "important" | "urgent" | "impactful" | "easy";
type TaskRow = {
  id: string;
  title: string;
  createdAt: number;
  important: boolean | null;
  urgent: boolean | null;
  impactful: boolean | null;
  easy: boolean | null;
  sphereIds: string[];
  actionKindId: string | null;
  categoryId: string | null;
  projectId: string | null;
  deadline: number | null;
  remindAt: number | null;
  deferred: boolean;
  deferredUntil: number | null;
  queued: boolean;
  waitingFor: string | null;
  firstStepText: string | null;
  flavor: "dopamine" | "frog" | null;
  ownerName: string | null;
  priority: number;
  level: Level;
  status: "now" | "paused";
};
type SortKey =
  | "priority"
  | "status"
  | "deadline"
  | "remindAt"
  | "deferredUntil"
  | "title"
  | "sphere"
  | "kind"
  | "category"
  | "project"
  | "flavor"
  | "created";
type FieldKey = "deadline" | "remindAt" | "deferred" | "queued" | "waitingFor" | "firstStep";
type Filters = {
  q: string;
  status: string;
  mark: string;
  sphere: string;
  kind: string;
  category: string;
  project: string;
  flavor: string;
  field: FieldKey | "";
  notFilled: boolean;
};
type Props = { language: Language; onSignedOut: () => void };

const marks: Mark[] = ["important", "urgent", "impactful", "easy"];
const markLabels: Record<Mark, TextKey> = {
  important: "field.important",
  urgent: "field.urgent",
  impactful: "field.impactful",
  easy: "field.easy",
};
const levelLabels: Record<Level, TextKey> = {
  top: "level.top",
  high: "level.high",
  medium: "level.medium",
  low: "level.low",
  none: "level.none",
};
const sortLabels: Record<SortKey, TextKey> = {
  priority: "sort.priority",
  status: "filter.status",
  deadline: "field.deadline",
  remindAt: "field.remindAt",
  deferredUntil: "field.deferredUntil",
  title: "field.name",
  sphere: "field.spheres",
  kind: "field.kind",
  category: "field.category",
  project: "field.project",
  flavor: "field.flavor",
  created: "sort.created",
};
const fieldLabels: Record<FieldKey, TextKey> = {
  deadline: "field.deadline",
  remindAt: "field.remindAt",
  deferred: "field.deferred",
  queued: "field.queued",
  waitingFor: "field.waitingFor",
  firstStep: "field.firstStep",
};
const filled: Record<FieldKey, (task: TaskRow) => boolean> = {
  deadline: (task) => task.deadline !== null,
  remindAt: (task) => task.remindAt !== null,
  deferred: (task) => task.deferred,
  queued: (task) => task.queued,
  waitingFor: (task) => task.waitingFor !== null,
  firstStep: (task) => task.firstStepText !== null,
};
const noFilters: Filters = {
  q: "",
  status: "",
  mark: "",
  sphere: "",
  kind: "",
  category: "",
  project: "",
  flavor: "",
  field: "",
  notFilled: false,
};

const strong = (task: TaskRow) => (task.important || task.impactful ? 1 : 0);
/** Пустые значения в конце при любом поле сортировки. */
const byNumber = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
const byText = (a: string | undefined, b: string | undefined) =>
  a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : a.localeCompare(b);

function comparators(names: Map<string, string>, text: Text): Record<SortKey, (a: TaskRow, b: TaskRow) => number> {
  const name = (id: string | null) => (id === null ? undefined : names.get(id));
  const sphere = (task: TaskRow) => task.sphereIds.map((id) => names.get(id) ?? "").sort((a, b) => a.localeCompare(b))[0];
  const flavor = (task: TaskRow) => (task.flavor === null ? undefined : text(`flavor.${task.flavor}`));
  return {
    priority: (a, b) => b.priority - a.priority || strong(b) - strong(a),
    status: (a, b) => (a.status === b.status ? 0 : a.status === "now" ? -1 : 1),
    deadline: (a, b) => byNumber(a.deadline, b.deadline),
    remindAt: (a, b) => byNumber(a.remindAt, b.remindAt),
    deferredUntil: (a, b) => byNumber(a.deferredUntil, b.deferredUntil),
    title: (a, b) => a.title.localeCompare(b.title),
    sphere: (a, b) => byText(sphere(a), sphere(b)),
    kind: (a, b) => byText(name(a.actionKindId), name(b.actionKindId)),
    category: (a, b) => byText(name(a.categoryId), name(b.categoryId)),
    project: (a, b) => byText(name(a.projectId), name(b.projectId)),
    flavor: (a, b) => byText(flavor(a), flavor(b)),
    created: (a, b) => b.createdAt - a.createdAt,
  };
}

function matches(task: TaskRow, f: Filters): boolean {
  return (
    (!f.q || task.title.toLowerCase().includes(f.q.toLowerCase())) &&
    (!f.status || task.status === f.status) &&
    (!f.mark || task[f.mark as Mark] === true) &&
    (!f.sphere || task.sphereIds.includes(f.sphere)) &&
    (!f.kind || task.actionKindId === f.kind) &&
    (!f.category || task.categoryId === f.category) &&
    (!f.project || task.projectId === f.project) &&
    (!f.flavor || task.flavor === f.flavor) &&
    (!f.field || filled[f.field](task) !== f.notFilled)
  );
}

export function Tasks({ language, onSignedOut }: Props) {
  const text: Text = (key) => t(language, key);
  const [tasks, setTasks] = useState<TaskRow[]>();
  const [lists, setLists] = useState<Lists>();
  const [projects, setProjects] = useState<Row[]>([]);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string>();
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [sortBy, setSortBy] = useState<SortKey>("priority");
  const [thenBy, setThenBy] = useState<SortKey | "">("deadline");

  const reload = useCallback(async () => {
    const [taskList, references, projectList] = await Promise.all([
      api<{ tasks: TaskRow[] }>("GET", "/tasks"),
      api<Lists>("GET", "/references"),
      api<{ projects: Row[] }>("GET", "/projects"),
    ]);
    const signedOut = [taskList, references, projectList].some((result) => result.status === 401);
    if (signedOut) onSignedOut();
    if (taskList.data && references.data && projectList.data) {
      setTasks(taskList.data.tasks);
      setLists(references.data);
      setProjects(projectList.data.projects);
      setFailed(false);
    } else if (!signedOut) setFailed(true);
  }, [onSignedOut]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (id: string) => {
    const result = await api("DELETE", `/items/${id}`);
    if (result.status === 401) onSignedOut();
    setOpenId(undefined);
    await reload();
  };

  if (!tasks || !lists) return failed ? <p role="alert">{text("error.load")}</p> : null;

  const set = (key: Exclude<keyof Filters, "notFilled">) => (value: string) => setFilters({ ...filters, [key]: value });
  const projectNames: NameRow[] = projects.map((project) => ({ id: project.id, name: project.title }));
  const names = new Map(
    [...lists.spheres, ...lists.actionKinds, ...lists.categories, ...projectNames].map((row) => [row.id, row.name]),
  );
  const compare = comparators(names, text);
  const shown = tasks
    .filter((task) => matches(task, filters))
    .sort((a, b) => compare[sortBy](a, b) || (thenBy ? compare[thenBy](a, b) : 0));

  return (
    <section>
      <input
        className="wide"
        type="search"
        aria-label={text("tasks.search")}
        placeholder={text("tasks.search")}
        value={filters.q}
        onChange={(event) => set("q")(event.target.value)}
      />
      <details className="filters-box">
        <summary>{text("filter.title")}</summary>
        <div className="filters">
        <Filter
          label={text("filter.status")}
          value={filters.status}
          options={[
            { id: "now", name: text("status.now") },
            { id: "paused", name: text("status.paused") },
          ]}
          any={text("filter.any")}
          onChange={set("status")}
        />
        <Filter
          label={text("filter.mark")}
          value={filters.mark}
          options={marks.map((mark) => ({ id: mark, name: text(markLabels[mark]) }))}
          any={text("filter.any")}
          onChange={set("mark")}
        />
        <Filter label={text("field.spheres")} value={filters.sphere} options={lists.spheres} any={text("filter.any")} onChange={set("sphere")} />
        <Filter label={text("field.kind")} value={filters.kind} options={lists.actionKinds} any={text("filter.any")} onChange={set("kind")} />
        <Filter label={text("field.category")} value={filters.category} options={lists.categories} any={text("filter.any")} onChange={set("category")} />
        <Filter label={text("field.project")} value={filters.project} options={projectNames} any={text("filter.any")} onChange={set("project")} />
        <Filter
          label={text("field.flavor")}
          value={filters.flavor}
          options={[
            { id: "dopamine", name: text("flavor.dopamine") },
            { id: "frog", name: text("flavor.frog") },
          ]}
          any={text("filter.any")}
          onChange={set("flavor")}
        />
        <Filter
          label={text("filter.field")}
          value={filters.field}
          options={(Object.keys(fieldLabels) as FieldKey[]).map((key) => ({ id: key, name: text(fieldLabels[key]) }))}
          any={text("filter.any")}
          onChange={set("field")}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={filters.notFilled}
            onChange={(event) => setFilters({ ...filters, notFilled: event.target.checked })}
          />
          {text("filter.notFilled")}
        </label>
        <Labeled label={text("sort.by")}>
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortKey)}>
            {(Object.keys(sortLabels) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {text(sortLabels[key])}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label={text("sort.then")}>
          <select value={thenBy} onChange={(event) => setThenBy(event.target.value as SortKey | "")}>
            <option value="" />
            {(Object.keys(sortLabels) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {text(sortLabels[key])}
              </option>
            ))}
          </select>
        </Labeled>
        </div>
      </details>
      {shown.length === 0 && <p className="empty">{text(tasks.length === 0 ? "list.empty" : "tasks.nothing")}</p>}
      <ul className="rows">
        {shown.map((task) => (
          <li key={task.id} className="row">
            <button
              type="button"
              className="row-title"
              aria-expanded={openId === task.id}
              onClick={() => {
                if (openId === task.id) void reload();
                setOpenId(openId === task.id ? undefined : task.id);
              }}
            >
              {task.title}
              <span className={`level level-${task.level}`}>{text(levelLabels[task.level])}</span>
              {task.ownerName !== null && <span className="owner">{t(language, "task.owner", { name: task.ownerName })}</span>}
            </button>
            {openId === task.id && (
              <CardForm
                id={task.id}
                text={text}
                lists={lists}
                projects={projects}
                ownerLabel={task.ownerName === null ? undefined : t(language, "task.owner", { name: task.ownerName })}
                onSignedOut={onSignedOut}
                onDelete={() => remove(task.id)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Filter(props: {
  label: string;
  value: string;
  options: NameRow[];
  any: string;
  onChange: (value: string) => void;
}) {
  return (
    <Labeled label={props.label}>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">{props.any}</option>
        {props.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Labeled>
  );
}
