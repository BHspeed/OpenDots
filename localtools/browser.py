"""Native browser for Dots: a visible Chrome (or Edge) window driven by Playwright.

Chrome is started as a normal process (sandbox on, no automation flags) with a
local DevTools port, and Playwright attaches to it. A Playwright-launched
browser is flagged as automated, which sites such as Google sign-in reject.

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
import subprocess
import time
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
    r"confirm|sign ?in|log ?in|sign ?up|register|subscribe|transfer|donate|accept|agree|install|download|upload|"
    # Trading and money movement always need the owner's approval.
    r"sell|trade|deposit|withdraw|higher|lower|call|put|invest|bet|wager|stake|cash ?out)\b",
    re.I,
)

# Marks visible interactive elements with data-ld-ref and describes them.
SNAPSHOT_JS = r"""
(maxElements) => {
  // Refs stay stable across snapshots for as long as an element exists, so a
  // ref read earlier keeps working after other actions.
  window.__ldNext = window.__ldNext || 1;
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],' +
    '[role=searchbox],[role=textbox],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"]),' +
    '[role=row],[role=gridcell],[role=listitem],[role=treeitem],[jsaction*="click"],[data-action]';
  const visible = e => { const r = e.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return false;
    if (r.bottom <= 0 || r.top >= innerHeight * 3) return false;
    const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const items = []; const seen = new Set();
  for (const e of document.querySelectorAll(sel)) if (!seen.has(e) && visible(e)) { seen.add(e); items.push(e); }
  // Many apps build buttons from divs/spans with click handlers: include the
  // outermost pointer-cursor element that has no interactive element inside.
  let checked = 0;
  for (const e of document.querySelectorAll('div,span,li,img,svg,label,td,p,i')) {
    if (++checked > 6000) break;
    if (seen.has(e) || e.closest(sel) || e.querySelector(sel) || !visible(e)) continue;
    if (getComputedStyle(e).cursor !== 'pointer') continue;
    const parent = e.parentElement;
    if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
    seen.add(e); items.push(e);
  }
  const inView = e => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; };
  items.sort((a, b) => Number(inView(b)) - Number(inView(a)));
  const out = [];
  for (const e of items.slice(0, maxElements)) {
    let ref = e.getAttribute('data-ld-ref');
    if (!ref) { ref = String(window.__ldNext++); e.setAttribute('data-ld-ref', ref); }
    const tag = e.tagName.toLowerCase();
    const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') ||
      e.getAttribute('title') || e.getAttribute('alt') || e.getAttribute('name') ||
      e.querySelector('[alt],[aria-label],title')?.getAttribute('alt') ||
      e.querySelector('[aria-label]')?.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({ ref: Number(ref), tag, role: e.getAttribute('role') || (e.matches(sel) ? '' : 'clickable'),
      type: e.getAttribute('type') || '', name, href: tag === 'a' ? e.href.slice(0, 120) : undefined,
      inView: inView(e) });
  }
  const main = document.querySelector('main, article, [role=main]') || document.body;
  return { elements: out, text: (main ? main.innerText : '').replace(/\n{3,}/g, '\n\n') };
}
"""


EXECUTABLES = {"chrome": "chrome.exe", "msedge": "msedge.exe"}
WINDOW = os.environ.get("LOCALTOOLS_BROWSER_SIZE", "1440,900")


def browser_executable() -> str:
    import winreg

    for channel in CHANNELS:
        exe = EXECUTABLES.get(channel, channel)
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                key_path = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe
                with winreg.OpenKey(hive, key_path) as key:
                    return winreg.QueryValue(key, None)
            except OSError:
                continue
    raise RuntimeError("Chrome or Edge is not installed.")


def debugger_up() -> bool:
    import httpx

    try:
        return httpx.get(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=1).status_code == 200
    except Exception:
        return False


def launch_chrome(url: str = "about:blank", debug: bool = True) -> subprocess.Popen:
    """Start a normal Chrome window on the Dots' profile (no automation flags)."""
    PROFILE.mkdir(parents=True, exist_ok=True)
    args = [
        browser_executable(),
        f"--user-data-dir={PROFILE}",
        f"--window-size={WINDOW}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if debug:
        args.append(f"--remote-debugging-port={CDP_PORT}")
    return subprocess.Popen(args + [url])


# Boxes of in-view marked elements (CSS pixels) for drawing numbered marks.
MARKS_JS = r"""
() => [...document.querySelectorAll('[data-ld-ref]')].flatMap(e => {
  const r = e.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return [];
  return [{ ref: Number(e.getAttribute('data-ld-ref')), x: r.left, y: r.top, w: r.width, h: r.height }];
})
"""
# A visible cursor that glides to each click, so the owner sees the AI's mouse.
CURSOR_JS = r"""
([x, y]) => {
  let c = document.getElementById('__ld_cursor');
  if (!c) {
    c = document.createElement('div'); c.id = '__ld_cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;' +
      'margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,90,54,.35);border:3px solid #ff5a36;' +
      'box-shadow:0 0 0 4px rgba(255,255,255,.7);transition:left .35s ease,top .35s ease;left:50%;top:50%';
    document.documentElement.appendChild(c);
  }
  c.style.left = x + 'px'; c.style.top = y + 'px';
}
"""
# What is at a point (for clicks chosen on the grid).
POINT_JS = r"""
([x, y]) => { const e = document.elementFromPoint(x, y); if (!e) return null;
  const t = e.closest('a,button,[role],input,textarea,select,[onclick],[jsaction]') || e;
  return { tag: t.tagName.toLowerCase(), role: t.getAttribute('role') || '', type: t.getAttribute('type') || '',
    name: (t.getAttribute('aria-label') || t.innerText || t.value || t.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80) }; }
"""
GRID_COLS, GRID_ROWS = 12, 8
# Model that points at screen targets. Qwen-VL models are trained for GUI grounding
# (benchmark on a dense mock inbox: 7/8 correct vs 4/8 for numbered marks with Gemma).
GROUNDING_MODEL = os.environ.get("LOCALTOOLS_GROUNDING_MODEL", "qwen3-vl:8b")
# Point coordinates arrive normalized to 0-1000 (Qwen-VL convention).
POINT_SCALE = 1000


def draw_marks(image, marks, scale):
    """Numbered boxes over each clickable element (high contrast labels)."""
    from PIL import ImageDraw, ImageFont

    image = image.convert("RGB")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arialbd.ttf", max(12, int(13 * scale)))
    except OSError:
        font = ImageFont.load_default()
    for m in marks:
        x0, y0 = m["x"] * scale, m["y"] * scale
        x1, y1 = x0 + m["w"] * scale, y0 + m["h"] * scale
        draw.rectangle([x0, y0, x1, y1], outline=(255, 40, 40), width=2)
        label = str(m["ref"])
        tw, th = draw.textbbox((0, 0), label, font=font)[2:]
        draw.rectangle([x0, y0, x0 + tw + 6, y0 + th + 4], fill=(255, 40, 40))
        draw.text((x0 + 3, y0 + 1), label, fill=(255, 255, 255), font=font)
    return image


def draw_grid(image):
    """Lettered grid (A1..L8) for clicking things without a box."""
    from PIL import ImageDraw, ImageFont

    image = image.convert("RGB")
    draw = ImageDraw.Draw(image)
    width, height = image.size
    cw, ch = width / GRID_COLS, height / GRID_ROWS
    try:
        font = ImageFont.truetype("arialbd.ttf", 16)
    except OSError:
        font = ImageFont.load_default()
    for c in range(GRID_COLS):
        for r in range(GRID_ROWS):
            x0, y0 = c * cw, r * ch
            draw.rectangle([x0, y0, x0 + cw, y0 + ch], outline=(0, 120, 255), width=1)
            draw.text((x0 + 4, y0 + 3), f"{chr(65 + c)}{r + 1}", fill=(0, 90, 220), font=font)
    return image


class Browser:
    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._refs: dict[int, dict] = {}
        self.lock = asyncio.Lock()

    async def page(self):
        if self._context is None:
            from playwright.async_api import async_playwright

            if self._pw is None:
                self._pw = await async_playwright().start()
            if not debugger_up():
                launch_chrome()
                deadline = time.time() + 20
                while not debugger_up():
                    if time.time() > deadline:
                        raise RuntimeError(
                            "Chrome did not open its local control port. If the Dots' browser window "
                            "is already open without it (e.g. from 'Sign in normally'), close it and retry."
                        )
                    await asyncio.sleep(0.3)
            # Attach to the normal Chrome process instead of launching an automated one.
            self._browser = await self._pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
            self._browser.on("disconnected", lambda *_: self._reset())
            self._context = self._browser.contexts[0]
        if self._page is None or self._page.is_closed():
            pages = [p for p in self._context.pages if not p.is_closed()]
            self._page = pages[-1] if pages else await self._context.new_page()
        return self._page

    def _reset(self) -> None:
        self._browser = None
        self._context = None
        self._page = None
        self._refs = {}

    async def snapshot(self, max_chars: int = 5000, max_elements: int = 150) -> dict:
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
        locator = page.locator(f'[data-ld-ref="{ref}"]').first
        if ref in self._refs:
            return self._refs[ref], locator
        if await locator.count():
            info = await locator.evaluate(
                """e => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '',
                type: e.getAttribute('type') || '', name: (e.getAttribute('aria-label') || e.innerText ||
                e.value || e.getAttribute('placeholder') || '').trim().slice(0, 80) })"""
            )
            self._refs[ref] = {"ref": ref, **info}
            return self._refs[ref], locator
        raise LookupError(
            f"Element [{ref}] is no longer on the page. Use browser_find with the button's text, "
            "or browser_snapshot, to get a current ref."
        )

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


def register(
    tool: Callable,
    confirm: Callable[[str], None],
    save_image: Callable[[Any, str], str],
    vision: Callable[..., str] | None = None,
) -> None:
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
            # Reuse a blank tab instead of leaving it behind.
            if new_tab and page.url != "about:blank":
                page = await browser._context.new_page()
                browser._page = page
            await page.goto(url, wait_until="domcontentloaded", timeout=45_000)

        return await act(work)

    @tool()
    async def browser_snapshot(max_chars: int = 5000) -> dict:
        """Re-read the current page: URL, title, visible text and numbered interactive elements [ref]."""
        async with browser.lock:
            return await browser.snapshot(max_chars=max_chars if max_chars > 0 else 5000)

    async def look(target: str):
        """Find a target on screen: a grounding model points at it; numbered
        marks and then a lettered grid are fallbacks."""
        from PIL import Image
        import io

        page = await browser.page()
        await browser.snapshot(max_chars=0, max_elements=250)
        marks = await page.evaluate(MARKS_JS)
        shot = Image.open(io.BytesIO(await page.screenshot()))
        viewport = await page.evaluate("() => [innerWidth, innerHeight]")
        scale = shot.width / max(1, viewport[0])
        pointed = await asyncio.to_thread(
            vision,
            shot,
            f"Point to: {target}. Answer only with JSON "
            '{"point": [x, y]} using coordinates normalized to 0-1000 for this image.',
            False,
            1600,
            GROUNDING_MODEL,
        )
        numbers = re.findall(r"-?\d+(?:\.\d+)?", pointed.split("</think>")[-1])
        if len(numbers) >= 2:
            x = min(max(float(numbers[0]), 0), POINT_SCALE) / POINT_SCALE * viewport[0]
            y = min(max(float(numbers[1]), 0), POINT_SCALE) / POINT_SCALE * viewport[1]
            # Report the marked element under the point (smallest box), if any.
            inside = [m for m in marks if m["x"] <= x <= m["x"] + m["w"] and m["y"] <= y <= m["y"] + m["h"]]
            ref = min(inside, key=lambda m: m["w"] * m["h"])["ref"] if inside else None
            from PIL import ImageDraw

            seen = shot.convert("RGB")
            dot = ImageDraw.Draw(seen)
            px, py = x * scale, y * scale
            dot.ellipse([px - 12, py - 12, px + 12, py + 12], outline=(255, 40, 40), width=4)
            return {"ref": ref, "x": x, "y": y, "image": save_image(seen, "pointed"), "how": "pointed"}
        marked = draw_marks(shot, marks, scale)
        path = save_image(marked, "marked")
        answer = await asyncio.to_thread(
            vision,
            marked,
            "This is a screenshot of a web page. Red numbered boxes mark clickable things. "
            f"Which box is: {target}? Reply with only the box number, or 0 if no box fits.",
            False,
        )
        number = int(re.search(r"\d+", answer).group()) if re.search(r"\d+", answer) else 0
        known = {m["ref"]: m for m in marks}
        if number in known:
            m = known[number]
            return {"ref": number, "x": m["x"] + m["w"] / 2, "y": m["y"] + m["h"] / 2, "image": path, "how": "marks"}
        # Fallback: a lettered grid for things without a box.
        gridded = draw_grid(shot)
        cell = await asyncio.to_thread(
            vision,
            gridded,
            "This is a screenshot of a web page with a blue lettered grid. "
            f"Which grid cell contains: {target}? Reply with only the cell label like C4, or NONE.",
            False,
        )
        found = re.search(r"\b([A-L])\s*([1-8])\b", cell.upper())
        if not found:
            raise LookupError(f"Could not find '{target}' on the screen. Try describing it differently or scroll.")
        col, row = ord(found.group(1)) - 65, int(found.group(2)) - 1
        return {
            "ref": None,
            "x": (col + 0.5) * viewport[0] / GRID_COLS,
            "y": (row + 0.5) * viewport[1] / GRID_ROWS,
            "image": save_image(gridded, "grid"),
            "cell": found.group(1) + found.group(2),
        }

    async def mouse_to(x: float, y: float):
        page = await browser.page()
        await page.evaluate(CURSOR_JS, [x, y])
        await page.mouse.move(x, y, steps=12)
        await asyncio.sleep(0.4)

    @tool()
    async def browser_visual_click(target: str) -> dict:
        """Look at the page and click something described in plain words, like a person with a mouse:
        e.g. 'the first email in the inbox', 'the blue Sign up button', 'the search icon'.
        Use this when browser_find cannot locate it or the page is a complex web app."""
        ensure_control()
        if vision is None:
            raise RuntimeError("No vision model is configured for look-and-click.")
        async with browser.lock:
            spot = await look(target)
            page = await browser.page()
            info = await page.evaluate(POINT_JS, [spot["x"], spot["y"]]) or {"tag": "", "role": "", "name": ""}
        name = info.get("name") or ""
        is_link = info.get("tag") == "a" or info.get("role") == "link"
        if not is_link and RISKY.search(name):
            await ask(f"Click \"{name or target}\" on {page.url}")

        async def work():
            await mouse_to(spot["x"], spot["y"])
            await page.mouse.click(spot["x"], spot["y"])
            where = (
                f"grid {spot.get('cell')}"
                if spot.get("cell")
                else f"[{spot['ref']}]"
                if spot["ref"] is not None
                else f"point ({round(spot['x'])}, {round(spot['y'])})"
            )
            return {"clicked": f"{where} {name or target}", "looked_at": spot["image"]}

        return await act(work)

    @tool()
    async def browser_visual_type(target: str, text: str, submit: bool = False) -> dict:
        """Look at the page, click the field described in plain words (e.g. 'the To field', 'the search bar'),
        and type text into it like a keyboard. submit=true presses Enter after."""
        ensure_control()
        if vision is None:
            raise RuntimeError("No vision model is configured for look-and-click.")
        async with browser.lock:
            spot = await look(target)
            page = await browser.page()
            info = await page.evaluate(POINT_JS, [spot["x"], spot["y"]]) or {"type": "", "role": "", "name": ""}
        name = info.get("name") or target
        is_search = info.get("type") == "search" or info.get("role") in ("searchbox", "combobox") or re.search(
            r"search|query|find", name, re.I
        )
        if info.get("type") == "password":
            await ask(f"Type a password into \"{name}\" on {page.url}")
        elif not is_search:
            shown = text if len(text) <= 120 else text[:120] + "..."
            await ask(f"Type into \"{name}\"{' and press Enter' if submit else ''}:\n\"{shown}\"")

        async def work():
            await mouse_to(spot["x"], spot["y"])
            await page.mouse.click(spot["x"], spot["y"])
            await page.keyboard.type(text, delay=15)
            if submit:
                await page.keyboard.press("Enter")
            return {"typed_into": name, "looked_at": spot["image"]}

        return await act(work)

    @tool()
    async def browser_find(text: str, max_results: int = 10) -> dict:
        """Find clickable elements or fields whose label contains text (e.g. 'Search', 'Next', 'Email').
        Returns their [ref] numbers for browser_click / browser_type. Prefer this over guessing refs."""
        async with browser.lock:
            await browser.snapshot(max_chars=0, max_elements=400)
            needle = (text or "").strip().lower()
            matches = [
                e for e in browser._refs.values()
                if needle and (needle in (e.get("name") or "").lower() or needle in (e.get("href") or "").lower())
            ]
            limit = max_results if max_results > 0 else 10
            return {
                "query": text,
                "matches": [
                    f"[{e['ref']}] {e['role'] or e['tag']}: {e['name'] or '(no label)'}"
                    + ("" if e.get("inView", True) else " (below)")
                    for e in matches[:limit]
                ],
                "hint": "" if matches else "Nothing matched; try a shorter word, scroll, or take browser_screenshot.",
            }

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
            # Attached over CDP, close() only disconnects; ask Chrome to exit.
            if browser._browser is not None:
                try:
                    session = await browser._browser.new_browser_cdp_session()
                    await session.send("Browser.close")
                except Exception:
                    pass
            browser._reset()
            return {"closed": True}
