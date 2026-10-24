import { useEffect, useMemo, useRef, useState } from "react";
import type { Effort, ModelInfo, PermissionMode, SlashCommand } from "../api";

const MODES: [PermissionMode, string][] = [
  ["default", "Ask permissions"],
  ["acceptEdits", "Accept edits"],
  ["plan", "Plan mode"],
  ["auto", "Auto"],
  ["bypassPermissions", "Bypass permissions"],
];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export type ComposerSettings = { model?: string; effort?: Effort; permissionMode: PermissionMode };

export function Composer(props: {
  running: boolean;
  disabled?: boolean;
  settings: ComposerSettings;
  models: ModelInfo[];
  commands: SlashCommand[];
  onSettings: (s: Partial<ComposerSettings>) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  const slash = /^\/(\S*)$/.exec(text);
  const matches = useMemo(
    () => (slash ? props.commands.filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase())).slice(0, 8) : []),
    [slash?.[1], props.commands],
  );

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 280) + "px";
  }, [text]);

  useEffect(() => setSel(0), [slash?.[1]]);

  const send = () => {
    if (!text.trim() || props.disabled) return;
    props.onSend(text.trim());
    setText("");
  };

  const complete = (c: SlashCommand) => {
    setText(`/${c.name} `);
    ta.current?.focus();
  };

  return (
    <div className="composer">
      {matches.length > 0 && (
        <div className="slash-menu">
          {matches.map((c, i) => (
            <button key={c.name} className={i === sel ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), complete(c))}>
              <span className="mono">/{c.name}</span> <span className="muted">{c.argumentHint}</span>
              <div className="muted small">{c.description}</div>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={2}
        value={text}
        placeholder={props.running ? "Queue a message for Claude…" : "Ask Claude to do something… ( / for commands )"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown") return e.preventDefault(), setSel((sel + 1) % matches.length);
            if (e.key === "ArrowUp") return e.preventDefault(), setSel((sel - 1 + matches.length) % matches.length);
            if (e.key === "Tab") return e.preventDefault(), complete(matches[sel]);
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
          if (e.key === "Escape" && props.running) props.onStop();
        }}
      />
      <div className="composer-bar">
        <select value={props.settings.permissionMode} onChange={(e) => props.onSettings({ permissionMode: e.target.value as PermissionMode })}>
          {MODES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <select value={props.settings.model ?? ""} onChange={(e) => props.onSettings({ model: e.target.value || undefined })}>
          <option value="">Default model</option>
          {props.models.map((m) => (
            <option key={m.value} value={m.value} title={m.description}>{m.displayName}</option>
          ))}
        </select>
        <select value={props.settings.effort ?? ""} onChange={(e) => props.onSettings({ effort: (e.target.value || undefined) as Effort })}>
          <option value="">Default effort</option>
          {EFFORTS.map((e) => (
            <option key={e} value={e}>{e} effort</option>
          ))}
        </select>
        <span className="spacer" />
        {props.running && <button onClick={props.onStop}>Stop</button>}
        <button className="primary" disabled={!text.trim() || props.disabled} onClick={send}>Send</button>
      </div>
    </div>
  );
}
