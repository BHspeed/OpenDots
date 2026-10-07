"""Native browser for Dots: a visible Chrome (or Edge) window driven by Playwright.

Pages are returned as readable text plus numbered interactive elements, so a
model clicks [ref] numbers instead of guessing pixels. The browser uses its own
persistent profile (logins stay, the owner's normal Chrome is untouched).
Reading, scrolling and following links run freely; typing and clicking
buttons that submit, buy, send, delete or sign in ask the owner first.
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

PROFILE = Path(os.environ.get("LOCALTOOLS_BROWSER_PROFILE", Path(__file__).parent / "browser-profile"))
CHANNELS = [c for c in os.environ.get("LOCALTOOLS_BROWSER", "chrome,msedge").split(",") if c]
# Local-only DevTools port so OpenDots can stream a live view and relay the
# owner's input into the same browser.
CDP_PORT = int(os.environ.get("LOCALTOOLS_CDP_PORT", "9333"))
# Present while the owner has taken control; agent actions wait for hand-back.
TAKEOVER_FLAG = Path(
    os.environ.get("LOCALTOOLS_TAKEOVER_FILE", Path(__file__).parent / "output" / "browser-takeover.flag")
)
RISKY = re.compile(
    r"\b(buy|pay|purchase|order|checkout|place order|send|post|publish|submit|delete|remove|"
    r"confirm|sign ?in|log ?in|sign ?up|register|subscribe|transfer|donate|accept|agree|install|download|upload)\b",
    re.I,
)

# Marks visible interactive elements with data-ld-ref and describes them.
SNAPSHOT_JS = r"""
(maxElements) => {
  document.querySelectorAll('[data-ld-ref]').forEach(e => e.removeAttribute('data-ld-ref'));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],' +
    '[role=searchbox],[role=textbox],[contenteditable=true]';
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' &&
      r.bottom > 0 && r.top < innerHeight * 3; };
  const out = []; let n = 0;
  for (const e of document.querySelectorAll(sel)) {
    if (!visible(e)) continue;
    n += 1; e.setAttribute('data-ld-ref', String(n));
    const tag = e.tagName.toLowerCase();
    const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') ||
      e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({ ref: n, tag, role: e.getAttribute('role') || '', type: e.getAttribute('type') || '',
      name, href: tag === 'a' ? e.href.slice(0, 120) : undefined,
      inView: e.getBoundingClientRect().top < innerHeight });
    if (out.length >= maxElements) break;
  }
  const main = document.querySelector('main, article, [role=main]') || document.body;
  return { elements: out, text: (main ? main.innerText : '').replace(/\n{3,}/g, '\n\n') };
}
"""


class Browser:
    def __init__(self) -> None:
        self._pw = None
        self._context = None
        self._page = None
        self._refs: dict[int, dict] = {}
        self.lock = asyncio.Lock()

    async def page(self):
        if self._context is None:
            from playwright.async_api import async_playwright

            self._pw = await async_playwright().start()
            PROFILE.mkdir(parents=True, exist_ok=True)
            errors = []
            for channel in CHANNELS:
                try:
                    self._context = await self._pw.chromium.launch_persistent_context(
                        str(PROFILE), channel=channel, headless=False, no_viewport=True,
                        args=[
                            # Fixed size keeps the live view readable on ultrawide screens.
                            f"--window-size={os.environ.get('LOCALTOOLS_BROWSER_SIZE', '1440,900')}",
                            f"--remote-debugging-port={CDP_PORT}",
                            "--remote-debugging-address=127.0.0.1",
                        ],
                    )
                    break
                except Exception as error:  # try the next installed browser
                    errors.append(f"{channel}: {error}")
            if self._context is None:
                raise RuntimeError("Could not start a browser. " + " | ".join(errors))
            self._context.on("close", lambda *_: self._reset())
        if self._page is None or self._page.is_closed():
            pages = [p for p in self._context.pages if not p.is_closed()]
            self._page = pages[-1] if pages else await self._context.new_page()
        return self._page

    def _reset(self) -> None:
        self._context = None
        self._page = None
        self._refs = {}

    async def snapshot(self, max_chars: int = 5000, max_elements: int = 80) -> dict:
        page = await self.page()
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=10_000)
        except Exception:
            pass
        data = await page.evaluate(SNAPSHOT_JS, max_elements)
        self._refs = {e["ref"]: e for e in data["elements"]}
        lines = []
        for e in data["elements"]:
            kind = e["role"] or (f"{e['tag']}[{e['type']}]" if e["type"] else e["tag"])
            extra = f" -> {e['href']}" if e.get("href") else ""
            lines.append(f"[{e['ref']}] {kind}: {e['name'] or '(no label)'}{extra}{'' if e['inView'] else ' (below)'}")
        text = data["text"]
        return {
            "url": page.url,
            "title": await page.title(),
            "tabs": len(self._context.pages),
            "elements": "\n".join(lines),
            "text": text[:max_chars] + ("\n...[truncated, use browser_read for more]" if len(text) > max_chars else ""),
        }

    async def element(self, ref: int):
        page = await self.page()
        if ref not in self._refs:
            raise LookupError(f"Unknown ref [{ref}]. Take a browser_snapshot and use a current ref.")
        return self._refs[ref], page.locator(f'[data-ld-ref="{ref}"]').first

    async def highlight(self, locator) -> None:
        """Outline the element briefly so the owner sees what the agent targets."""
        try:
            await locator.evaluate(
                """el => { const old = el.style.outline; el.style.outline = '3px solid #ff5a36';
                el.style.outlineOffset = '2px'; setTimeout(() => { el.style.outline = old; }, 1200); }"""
            )
            await asyncio.sleep(0.35)
        except Exception:
            pass

    async def settle(self) -> None:
        page = await self.page()
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=8000)
        except Exception:
            pass
        await asyncio.sleep(0.6)


def register(tool: Callable, confirm: Callable[[str], None], save_image: Callable[[Any, str], str]) -> None:
    browser = Browser()

    async def ask(action: str) -> None:
        await asyncio.to_thread(confirm, action)

    def ensure_control() -> None:
        if TAKEOVER_FLAG.exists():
            raise PermissionError(
                "The owner has taken control of the browser. Do not act; tell them you will "
                "continue once they hand control back, or ask what they want."
            )

    async def act(work: Callable[[], Awaitable[Any]], max_chars: int = 3000) -> dict:
        ensure_control()
        async with browser.lock:
            result = await work()
            await browser.settle()
            snap = await browser.snapshot(max_chars=max_chars)
            return {**(result or {}), **snap}

    @tool()
    async def browser_open(url: str, new_tab: bool = False) -> dict:
        """Open a web page in the Dots' own browser window and return its text and numbered elements."""
        url = url.strip()
        if not re.match(r"^[a-z]+://", url, re.I):
            url = "https://" + url

        async def work():
            page = await browser.page()
            if new_tab:
                page = await browser._context.new_page()
                browser._page = page
            await page.goto(url, wait_until="domcontentloaded", timeout=45_000)

        return await act(work)

    @tool()
    async def browser_snapshot(max_chars: int = 5000) -> dict:
        """Re-read the current page: URL, title, visible text and numbered interactive elements [ref]."""
        async with browser.lock:
            return await browser.snapshot(max_chars=max_chars if max_chars > 0 else 5000)

    @tool()
    async def browser_read(start: int = 0, max_chars: int = 15000) -> dict:
        """Read more of the current page's text (use start to page through long articles)."""
        async with browser.lock:
            page = await browser.page()
            text = await page.evaluate("() => document.body.innerText")
            limit = max_chars if max_chars > 0 else 15000
            return {"url": page.url, "length": len(text), "start": start, "text": text[start:start + limit]}

    @tool()
    async def browser_click(ref: int) -> dict:
        """Click element [ref] from the latest snapshot. Buttons that submit, buy, send, delete or sign in ask the owner first."""
        ensure_control()
        info, locator = await browser.element(ref)
        is_link = info["tag"] == "a" or info["role"] == "link"
        if not is_link and RISKY.search(info["name"] or ""):
            await ask(f"Click \"{info['name']}\" on {(await browser.page()).url}")

        async def work():
            await locator.scroll_into_view_if_needed(timeout=5000)
            await browser.highlight(locator)
            await locator.click(timeout=10_000)
            return {"clicked": f"[{ref}] {info['name']}"}

        return await act(work)

    @tool()
    async def browser_type(ref: int, text: str, submit: bool = False) -> dict:
        """Type text into field [ref] (replacing its content); submit=true presses Enter after. Asks the owner unless it is a search box."""
        ensure_control()
        info, locator = await browser.element(ref)
        is_search = info["type"] == "search" or info["role"] in ("searchbox", "combobox") or re.search(
            r"search|query|find", info["name"] or "", re.I
        )
        if info["type"] == "password":
            await ask(f"Type a password into \"{info['name']}\" on {(await browser.page()).url}")
        elif not is_search or submit and RISKY.search(info["name"] or ""):
            shown = text if len(text) <= 120 else text[:120] + "..."
            await ask(f"Type into \"{info['name'] or 'field'}\"{' and press Enter' if submit else ''}:\n\"{shown}\"")

        async def work():
            await browser.highlight(locator)
            await locator.fill(text, timeout=10_000)
            if submit:
                await locator.press("Enter")
            return {"typed_into": f"[{ref}] {info['name']}"}

        return await act(work)

    @tool()
    async def browser_select(ref: int, option: str) -> dict:
        """Choose an option (by visible label) in dropdown [ref]."""
        info, locator = await browser.element(ref)

        async def work():
            await locator.select_option(label=option, timeout=10_000)
            return {"selected": option}

        return await act(work)

    @tool()
    async def browser_press(key: str) -> dict:
        """Press a key in the page, e.g. 'Enter', 'Escape', 'PageDown', 'Control+F'."""

        async def work():
            await (await browser.page()).keyboard.press(key)
            return {"pressed": key}

        return await act(work)

    @tool()
    async def browser_scroll(direction: str = "down", pages: int = 1) -> dict:
        """Scroll the page 'down' or 'up' by a number of screens."""

        async def work():
            page = await browser.page()
            amount = (pages if pages > 0 else 1) * (-1 if direction.lower() == "up" else 1)
            await page.evaluate("(n) => window.scrollBy(0, n * window.innerHeight * 0.9)", amount)
            return {"scrolled": direction}

        return await act(work)

    @tool()
    async def browser_back() -> dict:
        """Go back to the previous page."""

        async def work():
            await (await browser.page()).go_back(timeout=20_000)

        return await act(work)

    @tool()
    async def browser_tabs() -> dict:
        """List open browser tabs."""
        async with browser.lock:
            page = await browser.page()
            return {
                "tabs": [
                    {"index": i, "title": await p.title(), "url": p.url, "active": p == page}
                    for i, p in enumerate(browser._context.pages)
                ]
            }

    @tool()
    async def browser_switch_tab(index: int) -> dict:
        """Switch to the browser tab with this index (see browser_tabs)."""

        async def work():
            pages = browser._context.pages
            if not 0 <= index < len(pages):
                raise IndexError(f"No tab {index}; there are {len(pages)} tabs.")
            browser._page = pages[index]
            await browser._page.bring_to_front()

        return await act(work)

    @tool()
    async def browser_screenshot(full_page: bool = False) -> dict:
        """Save a screenshot of the current page (pass its path to describe_image to look at it)."""
        from PIL import Image
        import io

        async with browser.lock:
            page = await browser.page()
            data = await page.screenshot(full_page=full_page)
            return {"path": save_image(Image.open(io.BytesIO(data)), "browser"), "url": page.url}

    @tool()
    async def browser_close() -> dict:
        """Close the Dots' browser window (the profile and logins are kept)."""
        async with browser.lock:
            if browser._context is not None:
                await browser._context.close()
            browser._reset()
            return {"closed": True}
