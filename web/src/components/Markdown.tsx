import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useOpenFile } from "../fileLinks";

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  const openFile = useOpenFile();
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
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
