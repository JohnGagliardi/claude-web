import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { readConfig } from "./state.js";

// Claude's own headless browser, driven through MCP tools. It uses a Chromium
// browser already installed on the device (Edge or Chrome), so nothing is
// downloaded, and runs headless so no window ever opens.
let browser: Promise<Browser> | undefined;

async function launch(): Promise<Browser> {
  const preferred = readConfig().browser?.channel;
  const channels = preferred ? [preferred] : process.platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge", "chromium"];
  let last: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`No usable Chromium browser (tried ${channels.join(", ")}): ${String((last as Error)?.message ?? last).split("\n")[0]}`);
}

function getBrowser() {
  browser ??= launch().catch((e) => {
    browser = undefined;
    throw e;
  });
  return browser;
}

type Tab = { context: BrowserContext; page: Page; console: string[] };
const tabs = new Map<string, Promise<Tab>>();

// One isolated browser context per live session.
export function tabFor(key: string): Promise<Tab> {
  let t = tabs.get(key);
  if (!t) {
    t = (async () => {
      const context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const tab: Tab = { context, page, console: [] };
      page.on("console", (m) => {
        tab.console.push(`[${m.type()}] ${m.text()}`);
        if (tab.console.length > 500) tab.console.shift();
      });
      page.on("pageerror", (e) => tab.console.push(`[pageerror] ${e.message}`));
      return tab;
    })();
    t.catch(() => tabs.delete(key));
    tabs.set(key, t);
  }
  return t;
}

export async function closeTab(key: string) {
  const t = tabs.get(key);
  tabs.delete(key);
  if (t) await t.then((x) => x.context.close()).catch(() => {});
}

export async function closeBrowser() {
  const b = browser;
  browser = undefined;
  if (b) await b.then((x) => x.close()).catch(() => {});
}
