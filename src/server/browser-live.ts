import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { McpTools } from './mcp-tools.js';

// Live view of the Dots' browser (launched by localtools with a local DevTools
// port). OpenDots attaches to the same browser to stream frames into the side
// panel and to relay the owner's input while they have taken control.
export interface LiveFrame {
  data: string;
  url: string;
  title: string;
  width: number;
  height: number;
  takeover: boolean;
}

export class LiveBrowser {
  private browser?: Browser;
  private active?: Page;
  private connecting?: Promise<Browser | undefined>;
  readonly takeoverFile: string;
  constructor(
    private cdpUrl = process.env.LOCALTOOLS_CDP_URL ?? 'http://127.0.0.1:9333',
    takeoverFile = process.env.LOCALTOOLS_TAKEOVER_FILE ??
      'localtools/output/browser-takeover.flag',
    private mcp?: McpTools,
  ) {
    this.takeoverFile = resolve(takeoverFile);
  }
  get takeover() {
    return existsSync(this.takeoverFile);
  }
  setTakeover(on: boolean) {
    if (on) {
      mkdirSync(dirname(this.takeoverFile), { recursive: true });
      writeFileSync(this.takeoverFile, String(Date.now()));
    } else rmSync(this.takeoverFile, { force: true });
  }
  private async connect(): Promise<Browser | undefined> {
    if (this.browser?.isConnected()) return this.browser;
    this.connecting ??= chromium
      .connectOverCDP(this.cdpUrl, { timeout: 3000 })
      .then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => (this.browser = undefined));
        // Follow whichever tab most recently navigated or was opened.
        const track = (page: Page) => {
          page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) this.active = page;
          });
          page.on('close', () => {
            if (this.active === page) this.active = undefined;
          });
        };
        for (const context of browser.contexts()) {
          context.pages().forEach(track);
          context.on('page', (page) => {
            track(page);
            this.active = page;
          });
        }
        return browser;
      })
      .catch(() => undefined)
      .finally(() => (this.connecting = undefined));
    return this.connecting;
  }
  /** Starts the Dots' browser through the local tools if it is not running. */
  async start(url = 'about:blank') {
    if (await this.connect())
      return this.goto(url === 'about:blank' ? '' : url);
    if (!this.mcp) throw new Error('Local tools are not configured.');
    await this.mcp.call('localtools', 'browser_open', { url });
    if (!(await this.connect()))
      throw new Error('The browser started but its live view is unavailable.');
  }
  /** The tab being worked on: last navigated, else a visible non-blank tab. */
  async page(): Promise<Page | undefined> {
    const browser = await this.connect();
    if (!browser) return undefined;
    if (this.active && !this.active.isClosed()) return this.active;
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .sort(
        (a, b) =>
          Number(b.url() !== 'about:blank') - Number(a.url() !== 'about:blank'),
      );
    for (const page of pages) {
      try {
        if ((await page.evaluate(() => document.visibilityState)) === 'visible')
          return page;
      } catch {
        // Page navigating or closed; try the next one.
      }
    }
    return pages[0];
  }
  async status() {
    const page = await this.page();
    return page
      ? {
          running: true,
          url: page.url(),
          title: await page.title().catch(() => ''),
          takeover: this.takeover,
        }
      : { running: false, url: '', title: '', takeover: this.takeover };
  }
  /** Streams JPEG frames of the active tab until the signal aborts. */
  async stream(onFrame: (frame: LiveFrame) => void, signal: AbortSignal) {
    let session: CDPSession | undefined;
    let current: Page | undefined;
    let meta = { width: 0, height: 0 };
    const attach = async () => {
      const page = await this.page();
      if (!page || page === current) return;
      await session?.detach().catch(() => undefined);
      current = page;
      session = await page.context().newCDPSession(page);
      session.on('Page.screencastFrame', (frame) => {
        meta = {
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
        };
        void session
          ?.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
          .catch(() => undefined);
        onFrame({
          data: frame.data,
          url: page.url(),
          title: '',
          ...meta,
          takeover: this.takeover,
        });
      });
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1600,
        maxHeight: 1000,
        everyNthFrame: 1,
      });
    };
    while (!signal.aborted) {
      try {
        await attach();
      } catch {
        current = undefined;
      }
      // Re-check the active tab; also keeps the stream alive across restarts.
      await new Promise((done) => setTimeout(done, 1000));
    }
    await session?.send('Page.stopScreencast').catch(() => undefined);
    await session?.detach().catch(() => undefined);
  }
  async goto(url: string) {
    const page = await this.require();
    if (!url) return;
    const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  async navigate(action: 'back' | 'forward' | 'reload') {
    const page = await this.require();
    if (action === 'back') await page.goBack({ timeout: 20_000 });
    else if (action === 'forward') await page.goForward({ timeout: 20_000 });
    else await page.reload({ timeout: 30_000 });
  }
  /** Owner input, in page CSS pixels. Only allowed while the owner has control. */
  async input(
    event:
      | { type: 'click'; x: number; y: number; button?: 'left' | 'right' }
      | { type: 'wheel'; dx: number; dy: number }
      | { type: 'key'; key: string }
      | { type: 'text'; text: string },
  ) {
    if (!this.takeover)
      throw new Error('Take control of the browser before interacting.');
    const page = await this.require();
    if (event.type === 'click')
      await page.mouse.click(event.x, event.y, { button: event.button });
    else if (event.type === 'wheel') {
      await page.mouse.wheel(event.dx, event.dy);
    } else if (event.type === 'key') await page.keyboard.press(event.key);
    else await page.keyboard.insertText(event.text);
  }
  private async require() {
    const page = await this.page();
    if (!page) throw new Error('The browser is not running. Start it first.');
    return page;
  }
  async close() {
    await this.browser?.close().catch(() => undefined);
  }
}
