import { useEffect, useRef, useState } from "react";
import type { Item } from "../transcript";
import { toolSummary } from "../transcript";
import { Markdown } from "./Markdown";

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

function ToolBody({ name, input }: { name: string; input: any }) {
  if ((name === "Edit" || name === "MultiEdit") && input) {
    const edits = name === "MultiEdit" ? input.edits ?? [] : [input];
    return (
      <div className="diff">
        <div className="muted mono">{input.file_path}</div>
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
        <div className="muted mono">{input.file_path}</div>
        <Clipped text={String(input.content ?? "")} />
      </div>
    );
  }
  if (name === "Bash" && input?.command) return <Clipped text={`$ ${input.command}`} />;
  return <Clipped text={JSON.stringify(input, null, 2)} />;
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
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
        {items.map((it) => {
          switch (it.kind) {
            case "user":
              return (
                <div key={it.id} className="user-msg">
                  {it.text}
                  {it.images > 0 && <div className="muted">{it.images} image(s)</div>}
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
        {partial && <Markdown text={partial} />}
        {running && !partial && <div className="working">Working…</div>}
        <div ref={end} />
      </div>
    </div>
  );
}
