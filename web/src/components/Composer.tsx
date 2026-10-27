import { useEffect, useMemo, useRef, useState } from "react";
import type { Effort, ModelInfo, PermissionMode, SlashCommand } from "../api";
import { stored, store, unstore } from "../storage";

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

// The composer is a contentEditable box, not a plain textarea, so typing "- "
// can render as a real sized bullet element live instead of staying literal
// text until the message is sent. The DOM is the source of truth for what's
// on screen; `text` (derived via domToText) only mirrors it for slash-command
// matching, the send button's disabled state, and the actual message sent.
const BULLET_CLASS = "bullet-mark";

function isBulletNode(n: Node | null | undefined): n is HTMLElement {
  return !!n && n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains(BULLET_CLASS);
}

// A drawn CSS circle, not a text glyph — so its size is an exact pixel value
// (see .bullet-mark), not whatever a font happens to render for some Unicode dot.
function makeBulletNode(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = BULLET_CLASS;
  span.contentEditable = "false";
  return span;
}

// Bullet markers read back as "- " so the plain-text model (sent to Claude,
// matched against slash commands) stays ordinary markdown.
function domToText(root: ParentNode): string {
  let out = "";
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeName === "BR") out += "\n";
    else if (isBulletNode(n)) out += "- ";
    else out += n.textContent ?? "";
  }
  return out;
}

function currentLineBeforeCaret(root: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.startContainer, r.startOffset);
  const before = domToText(pre.cloneContents());
  return before.slice(before.lastIndexOf("\n") + 1);
}

// Inserts a node at the (collapsed) range's position and advances the range
// to just after it, so a sequence of calls builds nodes left to right. For a
// text node specifically, the new position must be *inside* it (not just
// "after" it as a sibling index), or the next check of "is the caret right
// after a bullet marker" will see the wrong container type.
function insertAtCaret(range: Range, node: Node) {
  range.insertNode(node);
  if (node.nodeType === Node.TEXT_NODE) range.setStart(node, (node as Text).length);
  else range.setStartAfter(node);
  range.collapse(true);
}

// Typing "- " at the very start of a line (nothing before the dash on that
// line) swaps it for a bullet marker. Anything else is left alone.
function convertDashToBullet(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return false;
  const container = range.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) return false;
  const offset = range.startOffset;
  const text = container.textContent ?? "";
  if (offset < 1 || text[offset - 1] !== "-" || text.slice(0, offset - 1).length > 0) return false;
  const prev = container.previousSibling;
  if (prev && prev.nodeName !== "BR") return false;

  container.textContent = text.slice(0, offset - 1) + text.slice(offset);
  const space = document.createTextNode(" ");
  const bullet = makeBulletNode();
  const parent = container.parentNode!;
  parent.insertBefore(space, container);
  parent.insertBefore(bullet, space);

  const next = document.createRange();
  next.setStart(space, 1);
  next.collapse(true);
  sel.removeAllRanges();
  sel.addRange(next);
  return true;
}

// The reverse of domToText, for restoring a saved draft.
function textToDom(root: HTMLElement, text: string) {
  root.innerHTML = "";
  text.split("\n").forEach((line, i) => {
    if (i) root.appendChild(document.createElement("br"));
    if (line.startsWith("- ")) {
      root.appendChild(makeBulletNode());
      if (line.length > 2) root.appendChild(document.createTextNode(line.slice(2)));
    } else if (line) root.appendChild(document.createTextNode(line));
  });
}

// Index into root.childNodes right after the previous <br> (0 if none) — the
// start of the line the caret is currently on.
function lineStartIndex(root: HTMLElement, range: Range): number {
  const children = Array.from(root.childNodes);
  const caretIndex = range.startContainer === root ? range.startOffset - 1 : children.indexOf(range.startContainer as ChildNode);
  for (let i = caretIndex; i >= 0; i--) if (children[i]?.nodeName === "BR") return i + 1;
  return 0;
}

// Deletes everything from the start of the current line up to the caret
// (the marker is always exactly that line's content, so this removes it
// cleanly) and leaves the selection collapsed at the deletion point, landing
// on a plain empty line. A second Backspace from there merges with the
// previous line via the browser's own default handling — we don't force
// that on the first press, which would skip past the plain-empty-line step.
function deleteLinePrefix(root: HTMLElement, range: Range, sel: Selection): Range {
  const r = document.createRange();
  r.setStart(root, lineStartIndex(root, range));
  r.setEnd(range.startContainer, range.startOffset);
  r.deleteContents();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}

// Drops an empty bullet marker and moves to a plain new line — used when
// Shift+Enter is pressed on a line that's just the marker, to exit the list.
function exitEmptyBulletLine(root: HTMLElement, range: Range, sel: Selection) {
  const r = deleteLinePrefix(root, range, sel);
  const br = document.createElement("br");
  r.insertNode(br);
  r.setStartAfter(br);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

export function Composer(props: {
  running: boolean;
  disabled?: boolean;
  placeholder?: string;
  settings: ComposerSettings;
  models: ModelInfo[];
  // What the "Default" options resolve to, so they can say so.
  defaultModel?: string;
  defaultEffort?: Effort | null;
  commands: SlashCommand[];
  onSettings: (s: Partial<ComposerSettings>) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onError: (message: string) => void;
  // Unsent text is saved under this key, so it survives switching sessions.
  draftKey?: string;
}) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!ta.current) return;
    const saved = (props.draftKey && stored(`draft:${props.draftKey}`)) || "";
    textToDom(ta.current, saved);
    setText(saved);
  }, [props.draftKey]);

  const saveDraft = (t: string) => {
    if (!props.draftKey) return;
    if (t) store(`draft:${props.draftKey}`, t);
    else unstore(`draft:${props.draftKey}`);
  };

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

  const sync = () => {
    const t = domToText(ta.current!);
    setText(t);
    saveDraft(t);
  };

  const send = () => {
    if ((!text.trim() && !attachments.length) || props.disabled) return;
    props.onSend(text.trim(), attachments);
    if (ta.current) ta.current.innerHTML = "";
    setText("");
    saveDraft("");
    setAttachments([]);
  };

  const complete = (c: SlashCommand) => {
    const el = ta.current;
    if (!el) return;
    el.textContent = `/${c.name} `;
    setText(el.textContent);
    saveDraft(el.textContent);
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
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
      <div
        ref={ta}
        className="composer-input"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={props.placeholder ?? (props.running ? "Queue a message for Claude…" : "Ask Claude to do something… ( / for commands, paste or drop files )")}
        onInput={sync}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void addFiles(e.clipboardData.files);
            return;
          }
          e.preventDefault();
          const root = ta.current;
          const s = window.getSelection();
          if (!root || !s || s.rangeCount === 0) return;
          const r = s.getRangeAt(0);
          r.deleteContents();
          const lines = e.clipboardData.getData("text/plain").split("\n");
          lines.forEach((line, i) => {
            if (i > 0) insertAtCaret(r, document.createElement("br"));
            if (line) insertAtCaret(r, document.createTextNode(line));
          });
          s.removeAllRanges();
          s.addRange(r);
          sync();
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown") return e.preventDefault(), setSel((sel + 1) % matches.length);
            if (e.key === "ArrowUp") return e.preventDefault(), setSel((sel - 1 + matches.length) % matches.length);
            if (e.key === "Tab") return e.preventDefault(), complete(matches[sel]);
          }
          const root = ta.current;
          if (e.key === " " && !e.nativeEvent.isComposing && root && convertDashToBullet(root)) {
            e.preventDefault();
            sync();
            return;
          }
          if (e.key === "Enter" && !e.nativeEvent.isComposing && root) {
            const s = window.getSelection();
            const r = s && s.rangeCount ? s.getRangeAt(0) : null;
            if (e.shiftKey) {
              if (!r || !r.collapsed || !root.contains(r.startContainer)) return;
              e.preventDefault();
              const line = currentLineBeforeCaret(root) ?? "";
              if (line === "- ") {
                exitEmptyBulletLine(root, r, s!);
              } else {
                r.deleteContents();
                insertAtCaret(r, document.createElement("br"));
                if (line.startsWith("- ")) {
                  insertAtCaret(r, makeBulletNode());
                  insertAtCaret(r, document.createTextNode(" "));
                }
                s!.removeAllRanges();
                s!.addRange(r);
              }
              sync();
              return;
            }
            e.preventDefault();
            send();
          }
          if (e.key === "Backspace" && !e.nativeEvent.isComposing && root) {
            const s = window.getSelection();
            const r = s && s.rangeCount ? s.getRangeAt(0) : null;
            if (r && r.collapsed && root.contains(r.startContainer) && (currentLineBeforeCaret(root) ?? "") === "- ") {
              e.preventDefault();
              deleteLinePrefix(root, r, s!);
              sync();
              return;
            }
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
          <option value="">{props.defaultModel ? `Default (${props.defaultModel})` : "Default model"}</option>
          {props.models.map((m) => (
            <option key={m.value} value={m.value} title={m.description}>{m.displayName}</option>
          ))}
        </select>
        <select value={props.settings.effort ?? ""} onChange={(e) => props.onSettings({ effort: (e.target.value || undefined) as Effort })}>
          <option value="">{props.defaultEffort ? `Default effort (${props.defaultEffort})` : "Default effort"}</option>
          {EFFORTS.map((e) => (
            <option key={e} value={e}>{e} effort</option>
          ))}
        </select>
        <span className="spacer" />
        {props.running && (
          <button className="round stop" onClick={props.onStop} title="Stop (Esc)">
            ■
          </button>
        )}
        <button className="round primary" disabled={(!text.trim() && !attachments.length) || props.disabled} onClick={send} title="Send (Enter)">
          ↑
        </button>
      </div>
    </div>
  );
}
