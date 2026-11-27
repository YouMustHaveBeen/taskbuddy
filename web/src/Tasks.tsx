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
  flavor: "dopamine" | "frog" | null;
  priority: number;
  level: Level;
  status: "now" | "paused";
};
type SortKey = "priority" | "deadline" | "title" | "created";
type Filters = {
  q: string;
  status: string;
  mark: string;
  sphere: string;
  kind: string;
  category: string;
  project: string;
  flavor: string;
  deadline: string;
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
  deadline: "field.deadline",
  title: "field.name",
  created: "sort.created",
};
const noFilters: Filters = { q: "", status: "", mark: "", sphere: "", kind: "", category: "", project: "", flavor: "", deadline: "" };

const strong = (task: TaskRow) => (task.important || task.impactful ? 1 : 0);

const compare: Record<SortKey, (a: TaskRow, b: TaskRow) => number> = {
  priority: (a, b) => b.priority - a.priority || strong(b) - strong(a),
  deadline: (a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity),
  title: (a, b) => a.title.localeCompare(b.title),
  created: (a, b) => b.createdAt - a.createdAt,
};

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
    (!f.deadline || (f.deadline === "set") === (task.deadline !== null))
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

  const set = (key: keyof Filters) => (value: string) => setFilters({ ...filters, [key]: value });
  const shown = tasks
    .filter((task) => matches(task, filters))
    .sort((a, b) => compare[sortBy](a, b) || (thenBy ? compare[thenBy](a, b) : 0));
  const projectNames: NameRow[] = projects.map((project) => ({ id: project.id, name: project.title }));

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
          label={text("field.deadline")}
          value={filters.deadline}
          options={[
            { id: "set", name: text("deadline.set") },
            { id: "none", name: text("deadline.none") },
          ]}
          any={text("filter.any")}
          onChange={set("deadline")}
        />
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
            </button>
            {openId === task.id && (
              <CardForm
                id={task.id}
                text={text}
                lists={lists}
                projects={projects}
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
