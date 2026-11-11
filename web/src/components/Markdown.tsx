import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useOpenFile, useRunInTerminal } from "../fileLinks";

marked.setOptions({ gfm: true, breaks: false });

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

// Fence labels worth offering a "run" button for. Anything else (json, ts, …)
// renders as a plain code block, same as before this existed.
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "terminal"]);

marked.use({
  renderer: {
    code({ text, lang }) {
      const first = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase();
      const cls = first ? ` class="language-${escapeAttr(first)}"` : "";
      const body = `<pre><code${cls}>${escapeHtml(text)}\n</code></pre>`;
      if (!first || !SHELL_LANGS.has(first)) return body;
      const cmd = escapeAttr(text);
      return (
        `<div class="md-shell">${body}<div class="md-shell-bar">` +
        `<button type="button" class="link small" data-cmd="${cmd}" data-act="copy">Copy</button>` +
        `<button type="button" class="link small" data-cmd="${cmd}" data-act="run">▶ Run</button>` +
        `</div></div>`
      );
    },
  },
});

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  const openFile = useOpenFile();
  const runInTerminal = useRunInTerminal();
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const btn = target.closest("button[data-cmd]") as HTMLButtonElement | null;
        if (btn) {
          const cmd = btn.getAttribute("data-cmd") ?? "";
          if (btn.getAttribute("data-act") === "run") runInTerminal?.(cmd);
          else {
            void navigator.clipboard.writeText(cmd);
            const was = btn.textContent;
            btn.textContent = "Copied";
            setTimeout(() => (btn.textContent = was), 1200);
          }
          return;
        }
        const a = target.closest("a");
        const href = a?.getAttribute("href");
        if (!href || href.startsWith("#")) return;
        e.preventDefault();
        // Real URLs open in a new tab; anything else is a file path in the session's folder.
        if (/^[a-z][a-z0-9+.-]+:/i.test(href)) window.open(href, "_blank", "noopener");
        else openFile(href);
      }}
    />
  );
}
