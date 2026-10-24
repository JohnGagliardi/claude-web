import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { socket, type TerminalInfo } from "../api";

const theme = () => {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { background: v("--card"), foreground: v("--text"), cursor: v("--accent"), selectionBackground: "#88888855" };
};

function XTerm({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({ fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 13, theme: theme(), scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    let replayed = false;
    const pending: string[] = [];
    const off = socket.on((m) => {
      if (m.id !== id) return;
      if (m.t === "term:replay") {
        term.write(m.data);
        for (const d of pending.splice(0)) term.write(d);
        replayed = true;
      } else if (m.t === "term:data") {
        if (replayed) term.write(m.data);
        else pending.push(m.data);
      }
    });
    socket.send({ t: "term:attach", id });
    const input = term.onData((data) => socket.send({ t: "term:input", id, data }));
    const resize = () => {
      try {
        fit.fit();
        socket.send({ t: "term:resize", id, cols: term.cols, rows: term.rows });
      } catch {}
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host.current!);
    resize();
    term.focus();
    return () => {
      ro.disconnect();
      input.dispose();
      off();
      term.dispose();
    };
  }, [id]);

  return <div className="xterm-host" ref={host} />;
}

export function TerminalPane(props: {
  cwd: string;
  terminals: TerminalInfo[];
  selected?: string;
  onSelect: (id?: string) => void;
}) {
  const { terminals, selected } = props;
  // Prefer this session's folder, but every tab stays reachable.
  const ordered = [...terminals.filter((t) => t.cwd === props.cwd), ...terminals.filter((t) => t.cwd !== props.cwd)];
  const current = terminals.find((t) => t.id === selected) ?? ordered[0];

  const open = () => {
    const ref = crypto.randomUUID();
    const off = socket.on((m) => {
      if (m.t === "term:opened" && m.ref === ref) {
        off();
        props.onSelect(m.id);
      }
    });
    socket.send({ t: "term:open", ref, cwd: props.cwd });
  };

  return (
    <div className="term-pane">
      <div className="pane-bar term-tabs">
        {ordered.map((t) => (
          <span key={t.id} className={`term-tab ${t.id === current?.id ? "on" : ""} ${t.alive ? "" : "dead"}`} title={t.cwd}>
            <button className="link" onClick={() => props.onSelect(t.id)}>
              {t.byClaude ? "✦ " : ""}
              {t.title}
            </button>
            <button className="link" title="Close" onClick={() => socket.send({ t: "term:close", id: t.id })}>
              ×
            </button>
          </span>
        ))}
        <button onClick={open} title={`New terminal in ${props.cwd}`}>+ New</button>
      </div>
      {current ? (
        <>
          <XTerm key={current.id} id={current.id} />
          {!current.alive && <div className="muted small pad">Shell exited ({current.exitCode}).</div>}
        </>
      ) : (
        <div className="pane-empty">
          <button className="primary" onClick={open}>Open a terminal</button>
          <div className="muted small">in {props.cwd}</div>
        </div>
      )}
    </div>
  );
}
