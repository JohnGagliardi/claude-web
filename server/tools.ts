import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Terminals } from "./terminals.js";
import { launchConfigs, type Previews } from "./preview.js";
import { tabFor } from "./browser.js";

export const SERVER_NAME = "claude-web";

type Ctx = {
  key: string;
  cwd: string;
  terminals: Terminals;
  previews: Previews;
  // Shows the user what Claude's browser sees, in the Preview pane.
  onShot: (key: string, jpegBase64: string, url: string) => void;
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

// Tools that only read are pre-approved; everything else goes through the
// normal permission prompt.
export const READ_ONLY_TOOLS = [
  "terminal_list",
  "terminal_read",
  "preview_list",
  "preview_logs",
  "browser_screenshot",
  "browser_text",
  "browser_console",
].map((n) => `mcp__${SERVER_NAME}__${n}`);

export function sessionTools(ctx: Ctx): McpSdkServerConfigWithInstance {
  const previewId = (name: string) => `${ctx.cwd}::${name}`;

  const shot = async () => {
    const { page } = await tabFor(ctx.key);
    const buf = await page.screenshot({ type: "jpeg", quality: 60 });
    ctx.onShot(ctx.key, buf.toString("base64"), page.url());
  };

  const pageState = async () => {
    const { page } = await tabFor(ctx.key);
    void shot().catch(() => {});
    return `Now at ${page.url()} — "${await page.title()}"`;
  };

  const guard = async <T,>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> => {
    try {
      return await fn();
    } catch (e) {
      return fail(String((e as Error)?.message ?? e).split("\n").slice(0, 6).join("\n"));
    }
  };

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "1.0.0",
    instructions:
      "Tools for the user's claude-web app. Terminal tabs are shared with the user. Preview servers come from .claude/launch.json " +
      "in the session folder. The browser tools drive a headless browser the user can watch in the Preview pane.",
    tools: [
      tool("terminal_list", "List the terminal tabs (shared with the user) and whether each shell is still running.", {}, async () =>
        text(JSON.stringify(ctx.terminals.list(), null, 2)),
      ),
      tool(
        "terminal_read",
        "Read the recent output of a terminal tab as plain text. Omit tab_id for the most recent open tab.",
        { tab_id: z.string().optional(), lines: z.number().int().min(1).max(2000).optional() },
        async ({ tab_id, lines }) => {
          const r = ctx.terminals.read(tab_id, lines ?? 200);
          return r ? text(`[${r.info.title} · ${r.info.id} · ${r.info.alive ? "running" : `exited ${r.info.exitCode}`}]\n${r.text}`) : fail("No such terminal.");
        },
      ),
      tool(
        "terminal_run",
        "Type a command into a terminal tab the user can see, for long-running or interactive commands (dev servers, watchers). " +
          "Opens a new tab in the session folder when tab_id is omitted. Read the output later with terminal_read.",
        { command: z.string(), tab_id: z.string().optional() },
        async ({ command, tab_id }) => {
          const t = tab_id ? ctx.terminals.get(tab_id) : undefined;
          if (tab_id && !t) return fail("No such terminal.");
          const id = t?.id ?? ctx.terminals.open(ctx.cwd, { title: command.slice(0, 30), byClaude: true }).id;
          ctx.terminals.write(id, command + "\r");
          return text(`Sent to terminal ${id}.`);
        },
      ),
      tool("preview_list", "List the dev server configurations in .claude/launch.json and which are running.", {}, async () => {
        const running = ctx.previews.list().filter((p) => p.cwd === ctx.cwd);
        return text(JSON.stringify({ configurations: launchConfigs(ctx.cwd), running }, null, 2));
      }),
      tool(
        "preview_start",
        "Start (or reuse) a dev server from .claude/launch.json and wait for its port. The user sees it in the Preview pane.",
        { name: z.string() },
        async ({ name }) => guard(async () => text(JSON.stringify(await ctx.previews.start(ctx.cwd, name)))),
      ),
      tool("preview_stop", "Stop a dev server started with preview_start.", { name: z.string() }, async ({ name }) => {
        ctx.previews.stop(previewId(name));
        return text("Stopped.");
      }),
      tool(
        "preview_logs",
        "Read a dev server's recent stdout/stderr.",
        { name: z.string(), lines: z.number().int().min(1).max(2000).optional(), search: z.string().optional(), errors_only: z.boolean().optional() },
        async ({ name, lines, search, errors_only }) =>
          text(ctx.previews.logs(previewId(name), { lines, search, errorsOnly: errors_only }).join("\n") || "(no output)"),
      ),
      tool("browser_navigate", "Open a URL in the headless browser.", { url: z.string() }, async ({ url }) =>
        guard(async () => {
          const { page } = await tabFor(ctx.key);
          const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          return text(`${await pageState()} (HTTP ${res?.status() ?? "?"})`);
        }),
      ),
      tool(
        "browser_screenshot",
        "Screenshot the current page. Use for visual questions; prefer browser_text for reading content.",
        { full_page: z.boolean().optional() },
        async ({ full_page }) =>
          guard(async () => {
            const { page } = await tabFor(ctx.key);
            const buf = await page.screenshot({ type: "jpeg", quality: 70, fullPage: !!full_page });
            ctx.onShot(ctx.key, buf.toString("base64"), page.url());
            return { content: [{ type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" }] };
          }),
      ),
      tool("browser_text", "Get the visible text of the current page.", { max_chars: z.number().int().optional() }, async ({ max_chars }) =>
        guard(async () => {
          const { page } = await tabFor(ctx.key);
          const body = await page.evaluate(() => document.body?.innerText ?? "");
          return text(body.slice(0, max_chars ?? 30_000));
        }),
      ),
      tool(
        "browser_click",
        "Click an element by CSS selector, or by its visible text.",
        { selector: z.string().optional(), text: z.string().optional() },
        async ({ selector, text: label }) =>
          guard(async () => {
            const { page } = await tabFor(ctx.key);
            if (!selector && !label) return fail("Give a selector or text.");
            await (selector ? page.locator(selector) : page.getByText(label!, { exact: false })).first().click({ timeout: 10_000 });
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            return text(await pageState());
          }),
      ),
      tool(
        "browser_type",
        "Fill a field (CSS selector) with text; optionally press Enter after.",
        { selector: z.string(), text: z.string(), submit: z.boolean().optional() },
        async ({ selector, text: value, submit }) =>
          guard(async () => {
            const { page } = await tabFor(ctx.key);
            const el = page.locator(selector).first();
            await el.fill(value, { timeout: 10_000 });
            if (submit) await el.press("Enter");
            return text(await pageState());
          }),
      ),
      tool("browser_eval", "Run JavaScript in the page and return the JSON result. For inspection only.", { script: z.string() }, async ({ script }) =>
        guard(async () => {
          const { page } = await tabFor(ctx.key);
          const result = await page.evaluate(`(async () => (${script}))()`);
          return text(JSON.stringify(result, null, 2)?.slice(0, 30_000) ?? "undefined");
        }),
      ),
      tool("browser_console", "Recent console messages and page errors.", { limit: z.number().int().optional() }, async ({ limit }) =>
        guard(async () => text((await tabFor(ctx.key)).console.slice(-(limit ?? 50)).join("\n") || "(no console output)")),
      ),
    ],
  });
}
