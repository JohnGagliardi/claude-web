import { useEffect, useMemo, useRef, useState } from "react";
import type { Item } from "../transcript";
import { buildItems, isAgentTool, toolSummary } from "../transcript";
import { api, q, type RawMsg } from "../api";
import { Markdown } from "./Markdown";
import { useOpenFile, useSession } from "../fileLinks";

const LIMIT = 4000;

function Clipped({ text, className }: { text: string; className?: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > LIMIT;
  return (
    <pre className={className}>
      {all || !long ? text : text.slice(0, LIMIT)}
      {long && (
        <button className="link" onClick={() => setAll(!all)}>
          {all ? "\nshow less" : `\n… show ${text.length - LIMIT} more chars`}
        </button>
      )}
    </pre>
  );
}

function FilePath({ path }: { path?: string }) {
  const open = useOpenFile();
  if (!path) return null;
  return (
    <button className="link mono" onClick={() => open(path)} title="Open in file pane">
      {path}
    </button>
  );
}

function ToolBody({ name, input }: { name: string; input: any }) {
  if ((name === "Edit" || name === "MultiEdit") && input) {
    const edits = name === "MultiEdit" ? input.edits ?? [] : [input];
    return (
      <div className="diff">
        <FilePath path={input.file_path} />
        {edits.map((e: any, i: number) => (
          <pre key={i}>
            {String(e.old_string ?? "")
              .split("\n")
              .map((l, j) => (
                <div key={`o${j}`} className="del">- {l}</div>
              ))}
            {String(e.new_string ?? "")
              .split("\n")
              .map((l, j) => (
                <div key={`n${j}`} className="add">+ {l}</div>
              ))}
          </pre>
        ))}
      </div>
    );
  }
  if (name === "Write" && input) {
    return (
      <div>
        <FilePath path={input.file_path} />
        <Clipped text={String(input.content ?? "")} />
      </div>
    );
  }
  if (name === "Bash" && input?.command) return <Clipped text={`$ ${input.command}`} />;
  if (name === "Read" && input?.file_path) return <FilePath path={input.file_path} />;
  return <Clipped text={JSON.stringify(input, null, 2)} />;
}

// Strips the model-facing "agentId: … / usage" trailer from a subagent's report.
const agentReport = (text: string) => text.split(/\n\s*agentId: /)[0].trim();

function AgentCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<RawMsg[] | null>(null);
  const { sessionId, cwd } = useSession();
  const status = !item.result ? "running" : item.result.isError ? "error" : "ok";

  // Finished subagents from earlier turns are read from their own transcript file.
  useEffect(() => {
    if (!open || item.children.length || !item.agentId || !sessionId || stored) return;
    void api<RawMsg[]>(`/sessions/${sessionId}/subagents/${item.agentId}${q({ dir: cwd })}`)
      .then(setStored)
      .catch(() => setStored([]));
  }, [open, item.agentId, item.children.length, sessionId]);

  const msgs = item.children.length ? item.children : stored ?? [];
  const nested = useMemo(() => buildItems(msgs.map((m) => ({ ...m, parent_tool_use_id: null }))), [msgs]);
  const steps = nested.filter((n) => n.kind === "tool").length;
  return (
    <div className={`tool agent ${status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="dot" />
        <span className="tool-name">{item.input?.subagent_type ? `Agent · ${item.input.subagent_type}` : "Agent"}</span>
        <span className="tool-sum">{item.input?.description ?? ""}</span>
        {steps > 0 && <span className="muted small">{steps} steps</span>}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body">
          {item.input?.prompt && (
            <details>
              <summary className="muted small">Prompt</summary>
              <Markdown text={String(item.input.prompt)} />
            </details>
          )}
          {nested.length > 0 ? (
            <div className="nested">
              <ItemList items={nested} />
            </div>
          ) : (
            <div className="muted small">{item.result ? (item.agentId && sessionId && !stored ? "Loading…" : "No transcript available.") : "Working…"}</div>
          )}
          {item.result && (
            <div className={item.result.isError ? "err" : ""}>
              <div className="muted small">Report</div>
              <Markdown text={agentReport(item.result.text) || "(empty)"} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  if (isAgentTool(item.name)) return <AgentCard item={item} />;
  const status = !item.result ? "running" : item.result.isError ? "error" : "ok";
  return (
    <div className={`tool ${status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="dot" />
        <span className="tool-name">{item.name}</span>
        <span className="tool-sum">{toolSummary(item.name, item.input)}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <ToolBody name={item.name} input={item.input} />
          {item.result && <Clipped className={item.result.isError ? "err" : "out"} text={item.result.text || "(no output)"} />}
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Thinking
      </button>
      {open && <Markdown text={text} />}
    </div>
  );
}

export function Transcript({ items, partial, running }: { items: Item[]; partial: string; running: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: "end" });
  }, [items, partial]);

  return (
    <div
      className="transcript"
      ref={box}
      onScroll={() => {
        const el = box.current!;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="transcript-inner">
        <ItemList items={items} />
        {partial && <Markdown text={partial} />}
        {running && !partial && <div className="working">Working…</div>}
        <div ref={end} />
      </div>
    </div>
  );
}

function ItemList({ items }: { items: Item[] }) {
  return (
    <>
        {items.map((it) => {
          switch (it.kind) {
            case "user":
              return (
                <div key={it.id} className="user-msg">
                  {it.images.length > 0 && (
                    <div className="user-images">
                      {it.images.map((src, i) => (
                        <img key={i} src={src} alt="" />
                      ))}
                    </div>
                  )}
                  {it.documents > 0 && <div className="muted small">{it.documents} document(s) attached</div>}
                  {it.text}
                </div>
              );
            case "command":
              return <pre key={it.id} className="command">{it.text}</pre>;
            case "text":
              return <Markdown key={it.id} text={it.text} />;
            case "thinking":
              return <Thinking key={it.id} text={it.text} />;
            case "tool":
              return <ToolCard key={it.id} item={it} />;
            case "result":
              return <div key={it.id} className={`result ${it.ok ? "" : "err"}`}>{it.text}</div>;
            case "system":
              return <div key={it.id} className="result">{it.text}</div>;
          }
        })}
    </>
  );
}
