// oxlint-disable shadcn/no-unknown-classes -- standalone lab styles live in style.css
import { useState, type ReactNode } from "react";
import {
  Archive,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Plus,
  Search,
  Check,
  ChevronLeft,
  GitBranch,
  Home,
  Inbox,
  Layers,
  MessageSquare,
  X,
} from "lucide-react";

type Status = "working" | "approval" | "failed" | "settled";
const statusLabel: Record<Status, string> = {
  working: "Working",
  approval: "Needs you",
  failed: "Failed",
  settled: "Settled",
};

const agents: ReadonlyArray<{
  id: string;
  name: string;
  task: string;
  provider: string;
  status: Status;
  progress: number;
  last: string;
}> = [
  {
    id: "lead",
    name: "Lead",
    task: "Ship the workspace",
    provider: "Claude",
    status: "working",
    progress: 0.62,
    last: "Coordinating three children. Contract review is settled.",
  },
  {
    id: "ui",
    name: "Interface",
    task: "Rebuild thread rows",
    provider: "Claude",
    status: "working",
    progress: 0.4,
    last: "Editing ThreadRow.tsx, 3 of 5 rows done.",
  },
  {
    id: "review",
    name: "Review",
    task: "Audit the diff",
    provider: "Grok",
    status: "approval",
    progress: 0.8,
    last: "Wants to run the migration test suite.",
  },
  {
    id: "contract",
    name: "Contract",
    task: "Update schemas",
    provider: "Codex",
    status: "settled",
    progress: 1,
    last: "Schema updated, 14 tests pass.",
  },
];

const threads: ReadonlyArray<{
  id: string;
  title: string;
  project: string;
  status: Status;
  provider: string;
  last: string;
  agents: number;
}> = [
  {
    id: "ws",
    title: "Ship the workspace",
    project: "viewcode",
    status: "working",
    provider: "Claude",
    last: "Contract review settled. Interface and review still running.",
    agents: 4,
  },
  {
    id: "mig",
    title: "Review database migration",
    project: "viewcode",
    status: "approval",
    provider: "Codex",
    last: "Ready to apply migration 0042. Adds one column, removes nothing.",
    agents: 1,
  },
  {
    id: "rel",
    title: "Check the release build",
    project: "mobile",
    status: "failed",
    provider: "Grok",
    last: "composer.test.ts failed: focus moved to body.",
    agents: 1,
  },
  {
    id: "cmp",
    title: "Polish the composer",
    project: "viewcode",
    status: "settled",
    provider: "Claude",
    last: "Done. Padding and focus ring updated.",
    agents: 1,
  },
];

function Dot({ status }: { status: Status }) {
  return <span className="ph-dot" data-status={status} aria-hidden="true" />;
}

function Decision({ onDone }: { onDone: (text: string) => void }) {
  return (
    <div className="c-decision">
      <button
        type="button"
        className="c-btn"
        data-kind="primary"
        onClick={() => onDone("Approved in demo")}
      >
        <Check size={15} /> Approve
      </button>
      <button type="button" className="c-btn" onClick={() => onDone("Declined in demo")}>
        <X size={15} /> Decline
      </button>
    </div>
  );
}

/** Dashboard first: what is live, what needs you, what finished. */
function Pulse({ mark }: { mark: ReactNode }) {
  const [tab, setTab] = useState<"now" | "threads" | "inbox">("now");
  const [decision, setDecision] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const live = agents.filter((agent) => agent.id !== "lead");
  return (
    <div className="ph-page">
      <div className="c-scroll">
        <header className="c-pulse-head">
          <span className="c-brand">{mark} ViewCode</span>
          <span className="c-env">
            <span className="ph-online" /> MacBook Pro
          </span>
        </header>
        {tab === "now" && (
          <>
            <h1 className="c-display">
              3 agents working,
              <br />1 needs you.
            </h1>
            <button type="button" className="c-hero" onClick={() => setOpen(true)}>
              <span className="c-kicker">Live · viewcode</span>
              <strong>Ship the workspace</strong>
              <span className="c-segments" aria-label="Child agent progress">
                {live.map((agent) => (
                  <span key={agent.id} data-status={agent.status}>
                    <i style={{ width: `${agent.progress * 100}%` }} />
                  </span>
                ))}
              </span>
              <span className="c-hero-foot">
                {live.map((agent) => (
                  <span key={agent.id}>
                    <Dot status={agent.status} /> {agent.name}
                  </span>
                ))}
              </span>
            </button>
            <p className="c-label">Needs you</p>
            <div className="c-panel">
              <strong>Review wants to run the migration suite</strong>
              <span>Grok · child of Ship the workspace</span>
              {decision ? (
                <p className="c-done">
                  <Check size={14} /> {decision}. Nothing ran.
                </p>
              ) : (
                <Decision onDone={setDecision} />
              )}
            </div>
            <p className="c-label">Settled today</p>
            {threads
              .filter((item) => item.status === "settled" || item.status === "failed")
              .map((item) => (
                <div key={item.id} className="c-line">
                  <Dot status={item.status} />
                  <span>{item.title}</span>
                  <small>{statusLabel[item.status]}</small>
                </div>
              ))}
          </>
        )}
        {tab === "threads" && (
          <>
            <h1 className="c-display">Threads</h1>
            {threads.map((item) => (
              <div key={item.id} className="c-line c-line-tall">
                <Dot status={item.status} />
                <span>
                  {item.title}
                  <small>
                    {item.provider} · {item.project}
                  </small>
                </span>
                <small>{statusLabel[item.status]}</small>
              </div>
            ))}
          </>
        )}
        {tab === "inbox" && (
          <>
            <h1 className="c-display">Inbox</h1>
            <div className="c-line c-line-tall">
              <Dot status="approval" />
              <span>
                Review wants approval<small>Ship the workspace</small>
              </span>
            </div>
            <div className="c-line c-line-tall">
              <Dot status="failed" />
              <span>
                Release build failed<small>Check the release build</small>
              </span>
            </div>
          </>
        )}
      </div>
      <nav className="c-tabs" aria-label="Demo tabs">
        {(
          [
            ["now", Home, "Now"],
            ["threads", MessageSquare, "Threads"],
            ["inbox", Inbox, "Inbox"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            <Icon size={20} />
            <span>{label}</span>
            {id === "inbox" && <i className="c-badge">2</i>}
          </button>
        ))}
      </nav>
      {open && (
        <div className="c-overlay">
          <header className="c-overlay-head">
            <button
              type="button"
              className="c-icon"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <ChevronLeft size={22} />
            </button>
            <strong>Ship the workspace</strong>
            <span />
          </header>
          <div className="c-scroll">
            {agents.map((agent) => (
              <div key={agent.id} className="c-agent-row">
                <div>
                  <Dot status={agent.status} />
                  <b>{agent.name}</b>
                  <small>{agent.provider}</small>
                  <small>{Math.round(agent.progress * 100)}%</small>
                </div>
                <span className="c-bar" data-status={agent.status}>
                  <i style={{ width: `${agent.progress * 100}%` }} />
                </span>
                <p>{agent.last}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One thread per full-screen card; swipe between them and reply in place. */
function Deck({ mark }: { mark: ReactNode }) {
  const [index, setIndex] = useState(0);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <div className="ph-page">
      <header className="c-deck-head">
        <span className="c-brand">{mark}</span>
        <span className="c-pager" aria-label={`Thread ${index + 1} of ${threads.length}`}>
          {threads.map((item, i) => (
            <i key={item.id} data-active={i === index} />
          ))}
        </span>
        <span className="c-count">
          {index + 1}/{threads.length}
        </span>
      </header>
      <div
        className="c-deck"
        onScroll={(event) =>
          setIndex(Math.round(event.currentTarget.scrollLeft / event.currentTarget.clientWidth))
        }
      >
        {threads.map((item) => (
          <article key={item.id} className="c-card" data-status={item.status}>
            <span className="c-kicker">
              <Dot status={item.status} /> {statusLabel[item.status]} · {item.project}
            </span>
            <h2>{item.title}</h2>
            <p className="c-card-last">{item.last}</p>
            {replies[item.id] && <p className="c-card-reply">You: {replies[item.id]}</p>}
            <div className="c-card-meta">
              <span className="c-avatars">
                {Array.from({ length: item.agents }, (_, i) => (
                  <i key={i}>{i === 0 ? item.provider[0] : "·"}</i>
                ))}
              </span>
              {item.agents > 1 ? `${item.agents} agents` : item.provider}
            </div>
            <form
              className="c-card-reply-form"
              onSubmit={(event) => {
                event.preventDefault();
                const text = drafts[item.id]?.trim();
                if (!text) return;
                setReplies({ ...replies, [item.id]: text });
                setDrafts({ ...drafts, [item.id]: "" });
              }}
            >
              <input
                aria-label={`Reply to ${item.title}`}
                placeholder="Reply…"
                value={drafts[item.id] ?? ""}
                onChange={(event) => setDrafts({ ...drafts, [item.id]: event.target.value })}
              />
              <button type="submit" className="c-send" aria-label="Add demo reply">
                <ArrowUp size={16} />
              </button>
            </form>
          </article>
        ))}
      </div>
      <p className="c-swipe-hint">Swipe sideways between threads</p>
    </div>
  );
}

/** The lead and its children as a map; tap any node to talk to that agent. */
function Tree({ mark }: { mark: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  const agent = agents.find((item) => item.id === selected);
  return (
    <div className="ph-page">
      <div className="c-scroll">
        <header className="c-tree-head">
          <span className="c-brand">{mark} viewcode</span>
          <h1 className="c-display">Ship the workspace</h1>
          <span className="c-kicker">
            <GitBranch size={12} /> Lead + 3 children · 62%
          </span>
        </header>
        <div className="c-tree">
          {agents.map((item) => (
            <button
              type="button"
              key={item.id}
              className="c-node"
              data-root={item.id === "lead"}
              data-status={item.status}
              onClick={() => setSelected(item.id)}
            >
              <span className="c-node-ring" aria-hidden="true">
                <i style={{ height: `${item.progress * 100}%` }} />
              </span>
              <span className="c-node-body">
                <b>
                  {item.name} <small>{item.provider}</small>
                </b>
                <span>{item.task}</span>
              </span>
              <span className="c-node-status">{statusLabel[item.status]}</span>
            </button>
          ))}
        </div>
        <p className="c-swipe-hint">Tap any agent to see its work</p>
      </div>
      {agent && (
        <div className="ph-scrim" onClick={() => setSelected(null)}>
          <div
            className="ph-sheet"
            role="dialog"
            aria-label={agent.name}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="ph-grabber" aria-hidden="true" />
            <span className="c-kicker">
              <Dot status={agent.status} /> {statusLabel[agent.status]} · {agent.provider}
            </span>
            <strong className="c-sheet-title">
              {agent.name}: {agent.task}
            </strong>
            <p className="c-sheet-text">{agent.last}</p>
            {agent.status === "approval" &&
              (decision ? (
                <p className="c-done">
                  <Check size={14} /> {decision}. Nothing ran.
                </p>
              ) : (
                <Decision onDone={setDecision} />
              ))}
            <div className="c-card-reply-form">
              <input aria-label={`Message ${agent.name}`} placeholder={`Message ${agent.name}…`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const startingEvents = [
  {
    time: "10:42",
    agent: "Contract",
    status: "settled" as Status,
    text: "Schema updated. 14 tests pass.",
  },
  { time: "10:44", agent: "Interface", status: "working" as Status, text: "Editing ThreadRow.tsx" },
  {
    time: "10:45",
    agent: "Review",
    status: "approval" as Status,
    text: "Requests: run migration suite",
  },
  {
    time: "10:46",
    agent: "Lead",
    status: "working" as Status,
    text: "Waiting on Interface and Review",
  },
];

/** Command first: say what to do, then watch a live log of every agent. */
function Command({ mark }: { mark: ReactNode }) {
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("Lead");
  const [events, setEvents] = useState(startingEvents);
  const [decision, setDecision] = useState<string | null>(null);
  return (
    <div className="ph-page c-cmd">
      <form
        className="c-cmd-box"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          setEvents([
            ...events,
            { time: "now", agent: `You → ${target}`, status: "settled", text: draft.trim() },
          ]);
          setDraft("");
        }}
      >
        <span className="c-brand">{mark} viewcode</span>
        <textarea
          aria-label="Demo command"
          rows={2}
          placeholder="Tell your agents what to do…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="c-targets">
          {["Lead", "Interface", "Review", "New thread"].map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={target === name}
              onClick={() => setTarget(name)}
            >
              @{name}
            </button>
          ))}
          <button
            type="submit"
            className="c-send"
            aria-label="Add demo command"
            disabled={!draft.trim()}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </form>
      <p className="c-label c-label-inset">
        <Layers size={12} /> Live activity
      </p>
      <div className="c-scroll c-log">
        {events.map((event, i) => (
          // oxlint-disable-next-line react/no-array-index-key -- append-only demo log
          <div key={i} className="c-log-row" data-status={event.status}>
            <time>{event.time}</time>
            <span>
              <b>{event.agent}</b>
              {event.text}
            </span>
          </div>
        ))}
      </div>
      <div className="c-banner">
        {decision ? (
          <p className="c-done">
            <Check size={14} /> {decision}. Nothing ran.
          </p>
        ) : (
          <>
            <span>
              <Dot status="approval" /> Review needs approval
            </span>
            <Decision onDone={setDecision} />
          </>
        )}
      </div>
    </div>
  );
}

/** Same screens as today's app, cleaned up: grouped list, swipe, pill, thread, composer. */
function Refined({ mark }: { mark: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "needs">("all");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [swiped, setSwiped] = useState<string | null>(null);
  const [archived, setArchived] = useState<string[]>([]);
  const [showChildren, setShowChildren] = useState(true);
  const [decision, setDecision] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const thread = threads.find((item) => item.id === openId);
  const shown = threads.filter(
    (item) =>
      !archived.includes(item.id) &&
      (filter === "all" ||
        (filter === "active" && item.status === "working") ||
        (filter === "needs" && (item.status === "approval" || item.status === "failed"))),
  );

  if (thread) {
    return (
      <div className="ph-page">
        <header className="r-thread-head">
          <button
            type="button"
            className="c-icon"
            aria-label="Back"
            onClick={() => {
              setOpenId(null);
              setSent([]);
            }}
          >
            <ChevronLeft size={22} />
          </button>
          <div>
            <strong>{thread.title}</strong>
            <span>
              <Dot status={thread.status} /> {statusLabel[thread.status]} · {thread.provider} · High
            </span>
          </div>
          <button type="button" className="c-icon" aria-label="Thread menu">
            <MoreHorizontal size={20} />
          </button>
        </header>
        {thread.agents > 1 && (
          <button
            type="button"
            className="r-children-bar"
            aria-expanded={showChildren}
            onClick={() => setShowChildren(!showChildren)}
          >
            <GitBranch size={13} /> 3 child agents · 2 working
            {showChildren ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        {thread.agents > 1 && showChildren && (
          <div className="r-children">
            {agents
              .filter((agent) => agent.id !== "lead")
              .map((agent) => (
                <div key={agent.id}>
                  <Dot status={agent.status} />
                  <span>
                    <b>{agent.name}</b>
                    <small>{agent.last}</small>
                  </span>
                </div>
              ))}
          </div>
        )}
        <div className="c-scroll r-feed">
          <div className="ph-bubble">Keep it familiar. Let the lead coordinate.</div>
          <p>{thread.last}</p>
          {thread.status === "approval" && (
            <div className="c-panel">
              <strong>Apply migration 0042?</strong>
              <span>Adds one column. Nothing is removed.</span>
              {decision ? (
                <p className="c-done">
                  <Check size={14} /> {decision}. Nothing ran.
                </p>
              ) : (
                <Decision onDone={setDecision} />
              )}
            </div>
          )}
          {sent.map((message, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- append-only demo list
            <div className="ph-bubble" key={i}>
              {message}
            </div>
          ))}
        </div>
        <form
          className="r-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) return;
            setSent([...sent, draft.trim()]);
            setDraft("");
          }}
        >
          <textarea
            aria-label="Demo message"
            rows={1}
            placeholder="Ask the repo agent, or run a command…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="r-composer-row">
            <span className="r-chip">
              {thread.provider} <ChevronDown size={11} />
            </span>
            <span className="r-chip">High</span>
            <button
              type="submit"
              className="c-send"
              aria-label="Add demo message"
              disabled={!draft.trim()}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="ph-page">
      <header className="r-head">
        <div className="r-head-top">
          <span className="c-brand">{mark}</span>
          <span className="c-env">
            <span className="ph-online" /> MacBook Pro <ChevronDown size={12} />
          </span>
          <button type="button" className="c-icon" aria-label="Search">
            <Search size={18} />
          </button>
        </div>
        <h1 className="r-title">Threads</h1>
        <div className="r-filters" role="group" aria-label="Filter threads">
          {(
            [
              ["all", "All"],
              ["active", "Working"],
              ["needs", "Needs you"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
              {id === "needs" && <i>2</i>}
            </button>
          ))}
        </div>
      </header>
      <div className="c-scroll r-list">
        {["viewcode", "mobile"].map((project) => {
          const rows = shown.filter((item) => item.project === project);
          if (rows.length === 0) return null;
          const isCollapsed = collapsed.includes(project);
          return (
            <section key={project}>
              <button
                type="button"
                className="r-folder"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed(
                    isCollapsed ? collapsed.filter((p) => p !== project) : [...collapsed, project],
                  )
                }
              >
                <Folder size={14} /> {project} <small>{rows.length}</small>
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              {!isCollapsed &&
                rows.map((item) => (
                  <div key={item.id} className="r-row-wrap">
                    <button
                      type="button"
                      className="r-archive"
                      onClick={() => {
                        setArchived([...archived, item.id]);
                        setSwiped(null);
                      }}
                    >
                      <Archive size={16} /> Archive
                    </button>
                    <div className="r-row" data-swiped={swiped === item.id}>
                      <button
                        type="button"
                        className="r-row-main"
                        onClick={() => setOpenId(item.id)}
                      >
                        <span className="r-row-top">
                          <Dot status={item.status} />
                          <b>{item.title}</b>
                          <small>{item.status === "working" ? "now" : "12m"}</small>
                        </span>
                        <span className="r-row-preview">{item.last}</span>
                        <span className="r-row-meta">
                          {item.provider}
                          {item.agents > 1 && (
                            <>
                              {" "}
                              · <GitBranch size={11} /> {item.agents - 1} children
                            </>
                          )}
                          {item.status !== "settled" && (
                            <em data-status={item.status}>{statusLabel[item.status]}</em>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="r-more"
                        aria-label="Show swipe actions"
                        onClick={() => setSwiped(swiped === item.id ? null : item.id)}
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    </div>
                  </div>
                ))}
            </section>
          );
        })}
        {shown.length === 0 && <p className="ph-empty">Nothing here.</p>}
        {archived.length > 0 && (
          <button type="button" className="r-undo" onClick={() => setArchived([])}>
            Restore {archived.length} archived
          </button>
        )}
      </div>
      <div className="r-bottom">
        <span className="r-pill">
          <span className="ph-dot" data-status="working" /> 3 agents working
        </span>
        <button type="button" className="r-new">
          <Plus size={18} /> New thread
        </button>
      </div>
    </div>
  );
}

export const concepts = [
  {
    name: "Refined",
    idea: "Today's app, cleaned up. Same screens and code paths: grouped thread list, swipe to archive, working pill, thread screen and composer. Adds filters, message previews, a child-agent bar and calmer hierarchy.",
    Screen: Refined,
  },
  {
    name: "Pulse",
    idea: "Opens on what matters now: live agents, decisions waiting for you, and what finished. Tabs replace the thread list as home.",
    Screen: Pulse,
  },
  {
    name: "Deck",
    idea: "Every thread is a full-screen card. Swipe sideways through work and reply on the card without opening a chat.",
    Screen: Deck,
  },
  {
    name: "Tree",
    idea: "A lead agent and its children as a map with progress rings. Tap any agent to see its output or message it directly.",
    Screen: Tree,
  },
  {
    name: "Command",
    idea: "A command box comes first. Target an agent with @, then watch a live log of every agent below.",
    Screen: Command,
  },
] as const;
