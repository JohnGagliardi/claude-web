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

// Images go to Claude inline, PDFs as documents, anything else is uploaded and
// handed over by path.
export type Attachment = { id: string; name: string; kind: "image" | "pdf" | "file"; mediaType: string; data: string; size: number };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_FILE = 14 * 1024 * 1024;

function readAttachment(file: File): Promise<Attachment> {
  const kind: Attachment["kind"] = IMAGE_TYPES.includes(file.type) ? "image" : file.type === "application/pdf" ? "pdf" : "file";
  const limit = kind === "image" ? MAX_IMAGE : MAX_FILE;
  if (file.size > limit) return Promise.reject(new Error(`${file.name} is over ${Math.round(limit / 1024 / 1024)} MB.`));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name || `pasted.${file.type.split("/")[1] ?? "bin"}`,
        kind,
        mediaType: file.type || "application/octet-stream",
        data: String(r.result).split(",")[1] ?? "",
        size: file.size,
      });
    r.readAsDataURL(file);
  });
}

export function Composer(props: {
  running: boolean;
  disabled?: boolean;
  settings: ComposerSettings;
  models: ModelInfo[];
  commands: SlashCommand[];
  onSettings: (s: Partial<ComposerSettings>) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

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

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        const a = await readAttachment(f);
        setAttachments((list) => [...list, a]);
      } catch (e) {
        props.onError((e as Error).message);
      }
    }
  };

  const send = () => {
    if ((!text.trim() && !attachments.length) || props.disabled) return;
    props.onSend(text.trim(), attachments);
    setText("");
    setAttachments([]);
  };

  const complete = (c: SlashCommand) => {
    setText(`/${c.name} `);
    ta.current?.focus();
  };

  return (
    <div
      className={`composer ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
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
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span key={a.id} className="attachment" title={`${a.name} · ${Math.ceil(a.size / 1024)} KB`}>
              {a.kind === "image" ? <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name} /> : <span className="file-icon">{a.kind === "pdf" ? "PDF" : "FILE"}</span>}
              <span className="name">{a.name}</span>
              <button className="link" onClick={() => setAttachments((l) => l.filter((x) => x.id !== a.id))} title="Remove">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={2}
        value={text}
        placeholder={props.running ? "Queue a message for Claude…" : "Ask Claude to do something… ( / for commands, paste or drop files )"}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void addFiles(e.clipboardData.files);
          }
        }}
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
        <button className="link attach" title="Attach files" onClick={() => picker.current?.click()}>
          📎
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
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
        <button className="primary" disabled={(!text.trim() && !attachments.length) || props.disabled} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
