import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { Item } from "../transcript";
import { groupSummary, toolLabel, toolSummary } from "../transcript";
import { Markdown } from "./Markdown";
import { Compacted, UserText, WorkingIndicator, WrapUp } from "./Transcript";
import { useOpenFile, useSession } from "../fileLinks";

type ToolItem = Extract<Item, { kind: "tool" }>;
type Prompt = Extract<Item, { kind: "user" | "command" }>;
type Turn = { id: string; prompt?: Prompt; compact?: Extract<Item, { kind: "compact" }>; items: Item[] };

// Anything Claude says to the user starts a new turn: a prompt, a slash command
// or a background task reporting back.
function splitTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  for (const it of items) {
    if (it.kind === "user" || it.kind === "command") turns.push({ id: it.id, prompt: it, items: [] });
    // A compaction splits the work around it; the rest carries on without a prompt.
    else if (it.kind === "compact") turns.push({ id: it.id, compact: it, items: [] });
    else if (turns.length) turns[turns.length - 1].items.push(it);
    else turns.push({ id: `t:${it.id}`, items: [it] });
  }
  return turns;
}

const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

// Short "Let me check X" lines between tool calls are narration; anything
// longer or structured is an explanation worth reading.
const isNarration = (t: string) => t.length < 300 && !(t.length > 160 && /\n\s*([-*] |\d+\. |#|\|)/.test(t));

// AskUserQuestion results read `"question"="answer"`.
function answers(text: string): [string, string][] {
  return [...text.matchAll(/"([^"]+)"="([^"]*)"/g)].map((m) => [m[1], m[2]]);
}

type Step = { kind: "note"; id: string; text: string } | { kind: "tool"; id: string; item: ToolItem };

function Activity({ steps, live, tokens, partial }: { steps: Step[]; live: boolean; tokens: number; partial: string }) {
  const [open, setOpen] = useState(false);
  const tools = steps.filter((s): s is Extract<Step, { kind: "tool" }> => s.kind === "tool").map((s) => s.item);
  const last = steps[steps.length - 1];
  const current = partial || (last?.kind === "note" ? last.text : last ? stepLine(last.item) : "");
  if (!live && !steps.length) return null;
  const summary = groupSummary(tools);
  return (
    <div className={`sum-activity ${live ? "live" : ""}`}>
      {live ? (
        <>
          <WorkingIndicator running tokens={tokens} />
          {current && <div className="sum-current">{current.split("\n").filter(Boolean).slice(-2).join(" ")}</div>}
        </>
      ) : null}
      {steps.length > 0 && (
        <button className="link small sum-toggle" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {summary || `${steps.length} note${steps.length === 1 ? "" : "s"}`}
        </button>
      )}
      {open && (
        <ol className="sum-steps">
          {steps.map((s) =>
            s.kind === "note" ? (
              <li key={s.id} className="sum-step note">
                <Markdown text={s.text} />
              </li>
            ) : (
              <li key={s.id} className={`sum-step ${s.item.result?.isError ? "err" : ""}`}>
                <span className="sum-step-name">{toolLabel(s.item.name)}</span> {toolSummary(s.item.name, s.item.input)}
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

const stepLine = (t: ToolItem) => `${toolLabel(t.name)} · ${toolSummary(t.name, t.input)}`;

function ChangedFiles({ tools }: { tools: ToolItem[] }) {
  const open = useOpenFile();
  const { cwd } = useSession();
  const paths = [...new Set(tools.filter((t) => EDIT_TOOLS.test(t.name)).map((t) => t.input?.file_path ?? t.input?.notebook_path).filter(Boolean))] as string[];
  if (!paths.length) return null;
  const root = cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() + "/";
  const rel = (p: string) => {
    const n = p.replace(/\\/g, "/");
    return n.toLowerCase().startsWith(root) ? n.slice(root.length) : n;
  };
  return (
    <div className="sum-files">
      <span className="muted small">Changed</span>
      {paths.map((p) => (
        <button key={p} className="sum-file" title={p} onClick={() => open(p)}>
          {rel(p)}
        </button>
      ))}
    </div>
  );
}

function Question({ item }: { item: ToolItem }) {
  const qs: { question: string }[] = item.input?.questions ?? [];
  const got = answers(item.result?.text ?? "");
  return (
    <div className="sum-qa">
      {qs.map((q) => (
        <div key={q.question}>
          <div className="sum-q">{q.question}</div>
          <div className="sum-a">{got.find(([k]) => k === q.question)?.[1] ?? (item.result ? item.result.text : "Waiting for your answer")}</div>
        </div>
      ))}
    </div>
  );
}

// Long prompts are cut to a few lines with a fade; a click shows the rest.
// Only a bubble that really overflows fades, so short ones keep a solid background.
function PromptBubble({ prompt }: { prompt: Extract<Item, { kind: "user" }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !full) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [prompt.text, prompt.images.length, full]);
  return (
    <div ref={ref} className={`sum-prompt ${full ? "full" : clipped ? "clipped" : ""}`} onClick={() => clipped && setFull(true)}>
      {prompt.images.length > 0 && (
        <div className="user-images">
          {prompt.images.map((src, i) => (
            <img key={i} src={src} alt="" />
          ))}
        </div>
      )}
      <UserText text={prompt.text} />
    </div>
  );
}

function TurnView({ turn, live, tokens, partial }: { turn: Turn; live: boolean; tokens: number; partial: string }) {
  const { prompt, items } = turn;
  const tools = items.filter((i): i is ToolItem => i.kind === "tool" && !i.hidden);
  const lastTool = items.lastIndexOf(tools[tools.length - 1]);
  const steps: Step[] = [];
  const body: ReactElement[] = [];
  let footer: Extract<Item, { kind: "result" }> | undefined;
  items.forEach((it, i) => {
    switch (it.kind) {
      case "text":
        // What Claude says after its last tool call is the answer; while it's
        // still working, that may yet turn out to be narration.
        if ((i > lastTool && !live) || !isNarration(it.text))
          body.push(<div key={it.id} className={i > lastTool ? "sum-answer" : "sum-note"}><Markdown text={it.text} /></div>);
        else steps.push({ kind: "note", id: it.id, text: it.text });
        break;
      case "tool":
        if (it.hidden) break;
        if (it.name === "AskUserQuestion") body.push(<Question key={it.id} item={it} />);
        else if (it.name === "ExitPlanMode" && it.input?.plan)
          body.push(
            <div key={it.id} className="sum-plan">
              <div className="sum-label">Plan</div>
              <Markdown text={String(it.input.plan)} />
            </div>,
          );
        else steps.push({ kind: "tool", id: it.id, item: it });
        break;
      case "wrap":
        body.push(<WrapUp key={it.id} item={it} />);
        break;
      case "chapter":
        body.push(<h3 key={it.id} className="sum-chapter" title={it.summary}>{it.title}</h3>);
        break;
      case "system":
        body.push(<div key={it.id} className="result">{it.text}</div>);
        break;
      case "result":
        footer = it;
        break;
    }
  });
  return (
    <article className="sum-turn">
      {turn.compact && <Compacted summary={turn.compact.summary} />}
      {prompt?.kind === "user" && (
        <PromptBubble prompt={prompt} />
      )}
      {prompt?.kind === "command" && <div className="sum-prompt command">{prompt.text}</div>}
      {(body.length > 0 || steps.length > 0 || live) && (
        <div className="sum-card">
          <Activity steps={steps} live={live} tokens={tokens} partial={live ? partial : ""} />
          {!live && <ChangedFiles tools={tools} />}
          {body}
          {footer && !footer.ok && <div className="result err">{footer.text}</div>}
        </div>
      )}
    </article>
  );
}

// The reading view: each exchange as the prompt, then what Claude had to say
// about it, with the tool work folded into one line.
export function SummaryView({ items, partial, running, tokens, pendingCount }: { items: Item[]; partial: string; running: boolean; tokens: number; pendingCount: number }) {
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: "end" });
  }, [items, partial, pendingCount]);
  const turns = splitTurns(items);
  return (
    <div
      className="transcript summary"
      ref={box}
      onScroll={() => {
        const el = box.current!;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="transcript-inner sum-inner">
        {turns.map((t, i) => (
          <TurnView key={t.id} turn={t} live={running && i === turns.length - 1} tokens={tokens} partial={partial} />
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
