"""LocalTools: a local MCP server for files, vision, object detection and PC control.

Every tool runs on this machine. Vision uses the local Ollama model; detection
uses YOLO on the GPU. Actions that change files or drive the mouse/keyboard ask
the person through a native Windows Yes/No dialog first (set
LOCALTOOLS_CONFIRM=0 to disable, only if you trust every caller).

Run:  python server.py            (stdio, for OpenDots / Claude Code)
      python server.py --http     (streamable HTTP on 127.0.0.1:8765, for AJ)
"""

from __future__ import annotations

import base64
import ctypes
import fnmatch
import io
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

# Keep Ultralytics fully offline: no analytics sync or update checks.
os.environ.setdefault("YOLO_OFFLINE", "1")

import httpx
from mcp.server.mcpserver import MCPServer

HOME = Path.home()
ROOTS = [
    Path(p).expanduser().resolve()
    for p in os.environ.get("LOCALTOOLS_ROOTS", str(HOME)).split(os.pathsep)
    if p
]
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("LOCALTOOLS_VISION_MODEL", "qwen3-vl:8b")
YOLO_MODEL = os.environ.get("LOCALTOOLS_YOLO_MODEL", "yolo11n.pt")
CONFIRM = os.environ.get("LOCALTOOLS_CONFIRM", "1") != "0"
OUTPUT_DIR = Path(
    os.environ.get("LOCALTOOLS_OUTPUT", Path(__file__).parent / "output")
)
MAX_READ = 200_000

mcp = MCPServer(
    "localtools",
    instructions=(
        "Local tools on the owner's Windows PC: files, image understanding, "
        "object detection, screenshots and mouse/keyboard control. Risky "
        "actions show the owner a confirmation dialog; if declined, do not retry "
        "the same action without asking. Paths are limited to allowed roots."
    ),
)


# ---------------------------------------------------------------- safety


def confirm(action: str) -> None:
    """Ask the person before a risky action. Raises if declined."""
    if not CONFIRM:
        return
    MB_YESNO, MB_ICONQUESTION, MB_TOPMOST, MB_SETFOREGROUND = 0x4, 0x20, 0x40000, 0x10000
    IDYES = 6
    answer = ctypes.windll.user32.MessageBoxW(
        None,
        f"An AI assistant wants to:\n\n{action}\n\nAllow this?",
        "LocalTools - confirm action",
        MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND,
    )
    if answer != IDYES:
        raise PermissionError(f"The owner declined: {action}")


def safe_path(path: str) -> Path:
    resolved = Path(path).expanduser().resolve()
    if not any(resolved == root or root in resolved.parents for root in ROOTS):
        raise PermissionError(
            f"{resolved} is outside the allowed roots: {', '.join(map(str, ROOTS))}"
        )
    return resolved


def describe_entry(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "path": str(path),
        "type": "dir" if path.is_dir() else "file",
        "size": stat.st_size if path.is_file() else None,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------- files


@mcp.tool()
def list_directory(path: str = "~", pattern: str = "*", limit: int = 200) -> dict:
    """List files and folders in a directory, optionally filtered by a glob pattern like '*.png'."""
    folder = safe_path(path)
    entries = [
        describe_entry(p)
        for p in sorted(folder.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        if fnmatch.fnmatch(p.name.lower(), pattern.lower())
    ]
    return {"path": str(folder), "count": len(entries), "entries": entries[:limit]}


@mcp.tool()
def find_files(root: str, pattern: str = "*", contains: str = "", limit: int = 100) -> dict:
    """Recursively search under root for files whose name matches a glob pattern, optionally containing text."""
    base = safe_path(root)
    matches: list[dict] = []
    skip = {".git", "node_modules", ".venv", "__pycache__", "AppData"}
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for name in filenames:
            if not fnmatch.fnmatch(name.lower(), pattern.lower()):
                continue
            path = Path(dirpath) / name
            if contains:
                try:
                    if path.stat().st_size > 5_000_000 or contains.lower() not in path.read_text(
                        encoding="utf-8", errors="ignore"
                    ).lower():
                        continue
                except OSError:
                    continue
            matches.append(describe_entry(path))
            if len(matches) >= limit:
                return {"truncated": True, "matches": matches}
    return {"truncated": False, "matches": matches}


@mcp.tool()
def read_text_file(path: str, max_chars: int = 20_000) -> dict:
    """Read a text file (code, notes, logs, csv, json...)."""
    file = safe_path(path)
    text = file.read_text(encoding="utf-8", errors="replace")
    limit = min(max_chars, MAX_READ)
    return {"path": str(file), "truncated": len(text) > limit, "text": text[:limit]}


@mcp.tool()
def write_text_file(path: str, content: str, overwrite: bool = False) -> dict:
    """Create a text file. Overwriting an existing file asks the owner first."""
    file = safe_path(path)
    if file.exists():
        if not overwrite:
            raise FileExistsError(f"{file} exists; pass overwrite=true to replace it.")
        confirm(f"Overwrite file:\n{file}")
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content, encoding="utf-8")
    return {"written": str(file), "chars": len(content)}


@mcp.tool()
def make_directory(path: str) -> dict:
    """Create a folder (and any missing parents)."""
    folder = safe_path(path)
    folder.mkdir(parents=True, exist_ok=True)
    return {"created": str(folder)}


@mcp.tool()
def copy_path(source: str, destination: str) -> dict:
    """Copy a file or folder. Never overwrites an existing destination."""
    src, dst = safe_path(source), safe_path(destination)
    if dst.exists():
        raise FileExistsError(f"{dst} already exists.")
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return {"copied": str(src), "to": str(dst)}


@mcp.tool()
def move_paths(moves: list[dict[str, str]]) -> dict:
    """Move or rename files/folders. moves = [{"source": ..., "destination": ...}]. Asks the owner once for the whole batch."""
    pairs = [(safe_path(m["source"]), safe_path(m["destination"])) for m in moves]
    for src, dst in pairs:
        if not src.exists():
            raise FileNotFoundError(str(src))
        if dst.exists():
            raise FileExistsError(f"{dst} already exists.")
    preview = "\n".join(f"{s.name} -> {d}" for s, d in pairs[:15])
    more = f"\n...and {len(pairs) - 15} more" if len(pairs) > 15 else ""
    confirm(f"Move {len(pairs)} item(s):\n{preview}{more}")
    for src, dst in pairs:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    return {"moved": len(pairs)}


@mcp.tool()
def delete_to_recycle_bin(paths: list[str]) -> dict:
    """Send files/folders to the Recycle Bin (recoverable). Asks the owner first."""
    from send2trash import send2trash

    targets = [safe_path(p) for p in paths]
    confirm("Move to Recycle Bin:\n" + "\n".join(str(t) for t in targets[:15]))
    for target in targets:
        send2trash(str(target))
    return {"recycled": [str(t) for t in targets]}


# ---------------------------------------------------------------- screen & vision


def _screenshot(monitor: int = 1):
    import mss
    from PIL import Image

    with mss.mss() as grab:
        shot = grab.grab(grab.monitors[monitor])
        return Image.frombytes("RGB", shot.size, shot.rgb)


def _load_image(path: str):
    from PIL import Image

    if path.lower() in ("screen", "screenshot"):
        return _screenshot()
    return Image.open(safe_path(path)).convert("RGB")


def _save(image, prefix: str) -> str:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUTPUT_DIR / f"{prefix}-{datetime.now():%Y%m%d-%H%M%S}.png"
    image.save(out)
    return str(out)


@mcp.tool()
def take_screenshot(monitor: int = 1) -> dict:
    """Capture the screen to a PNG file. Returns its path and size (use describe_image or detect_objects on it)."""
    image = _screenshot(monitor)
    return {"path": _save(image, "screen"), "width": image.width, "height": image.height}


@mcp.tool()
def describe_image(path: str, question: str = "Describe this image in detail.") -> dict:
    """Understand an image with the local vision model: describe it, read its text (OCR), answer questions.
    path can be an image file or 'screen' for the current screen."""
    image = _load_image(path)
    image.thumbnail((1600, 1600))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    response = httpx.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": VISION_MODEL,
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": question,
                    "images": [base64.b64encode(buffer.getvalue()).decode()],
                }
            ],
        },
        timeout=300,
    )
    response.raise_for_status()
    return {"model": VISION_MODEL, "answer": response.json()["message"]["content"]}


_yolo = None


@mcp.tool()
def detect_objects(path: str = "screen", confidence: float = 0.35, save_annotated: bool = True) -> dict:
    """Detect and locate objects (people, cars, cups, laptops... 80 COCO classes) with YOLO on the GPU.
    path can be an image file or 'screen'. Returns labels, confidence and pixel boxes."""
    global _yolo
    from ultralytics import YOLO, settings

    if _yolo is None:
        settings.update({"sync": False})
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        _yolo = YOLO(str(Path(__file__).parent / YOLO_MODEL) if (Path(__file__).parent / YOLO_MODEL).exists() else YOLO_MODEL)
    image = _load_image(path)
    result = _yolo.predict(image, conf=confidence, verbose=False)[0]
    objects = [
        {
            "label": result.names[int(box.cls)],
            "confidence": round(float(box.conf), 3),
            "box": [round(v) for v in box.xyxy[0].tolist()],
        }
        for box in result.boxes
    ]
    out: dict[str, Any] = {"count": len(objects), "objects": objects}
    if save_annotated:
        from PIL import Image

        out["annotated"] = _save(Image.fromarray(result.plot()[:, :, ::-1]), "detect")
    return out


# ---------------------------------------------------------------- web (opt-in)


@mcp.tool()
def web_search(query: str, max_results: int = 6) -> dict:
    """Search the public web with DuckDuckGo. The query is sent to DuckDuckGo; nothing else leaves the PC."""
    from ddgs import DDGS

    # DuckDuckGo only: ddgs otherwise fans out to several search engines.
    results = DDGS(timeout=20).text(
        query, max_results=max(1, min(max_results, 10)), backend="duckduckgo"
    )
    return {
        "query": query,
        "results": [
            {"title": r.get("title"), "url": r.get("href"), "snippet": r.get("body")}
            for r in results
        ],
    }


@mcp.tool()
def fetch_page(url: str, max_chars: int = 12_000) -> dict:
    """Read a public web page and return its main text."""
    import re
    from html import unescape

    if not url.startswith(("http://", "https://")):
        raise ValueError("Only http(s) URLs can be fetched.")
    response = httpx.get(
        url,
        follow_redirects=True,
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0 (LocalTools reader)"},
    )
    response.raise_for_status()
    html = response.text
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    html = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header)[^>]*>.*?</\1>", " ", html)
    text = unescape(re.sub(r"<[^>]+>", " ", html))
    text = re.sub(r"\s+", " ", text).strip()
    return {
        "url": str(response.url),
        "title": unescape(title.group(1).strip()) if title else "",
        "text": text[: min(max_chars, 50_000)],
    }


# ---------------------------------------------------------------- PC control


@mcp.tool()
def list_windows() -> dict:
    """List visible top-level windows with their titles and positions."""
    import pygetwindow as gw

    return {
        "windows": [
            {"title": w.title, "left": w.left, "top": w.top, "width": w.width, "height": w.height, "active": w.isActive}
            for w in gw.getAllWindows()
            if w.title.strip() and w.visible and w.width > 0
        ]
    }


@mcp.tool()
def focus_window(title_contains: str) -> dict:
    """Bring the first window whose title contains the text to the front."""
    import pygetwindow as gw

    matches = [w for w in gw.getAllWindows() if title_contains.lower() in w.title.lower()]
    if not matches:
        raise LookupError(f"No window title contains '{title_contains}'.")
    window = matches[0]
    if window.isMinimized:
        window.restore()
    window.activate()
    return {"focused": window.title}


@mcp.tool()
def mouse_click(x: int, y: int, button: str = "left", clicks: int = 1) -> dict:
    """Click at screen pixel (x, y). Take a screenshot first to find coordinates. Asks the owner first."""
    import pyautogui

    confirm(f"{button}-click {clicks}x at ({x}, {y})")
    pyautogui.click(x=x, y=y, button=button, clicks=clicks, interval=0.1)
    return {"clicked": [x, y], "button": button, "clicks": clicks}


@mcp.tool()
def type_text(text: str) -> dict:
    """Type text into the focused window. Asks the owner first."""
    import pyautogui

    shown = text if len(text) <= 200 else text[:200] + "..."
    confirm(f"Type into the active window:\n\"{shown}\"")
    pyautogui.write(text, interval=0.01) if text.isascii() else _paste(text)
    return {"typed_chars": len(text)}


def _paste(text: str) -> None:
    import pyautogui
    import subprocess

    subprocess.run(["clip"], input=text.encode("utf-16le"), check=True)
    pyautogui.hotkey("ctrl", "v")


@mcp.tool()
def press_keys(keys: list[str]) -> dict:
    """Press a key or shortcut together, e.g. ["ctrl","s"], ["alt","tab"], ["enter"]. Asks the owner first."""
    import pyautogui

    confirm(f"Press keys: {' + '.join(keys)}")
    pyautogui.hotkey(*keys)
    return {"pressed": keys}


@mcp.tool()
def scroll(amount: int, x: int | None = None, y: int | None = None) -> dict:
    """Scroll the mouse wheel; positive = up, negative = down (about 120 per notch)."""
    import pyautogui

    pyautogui.scroll(amount, x=x, y=y)
    return {"scrolled": amount}


@mcp.tool()
def open_path(path: str) -> dict:
    """Open a file or folder with its default Windows app. Asks the owner first."""
    target = safe_path(path)
    confirm(f"Open:\n{target}")
    os.startfile(str(target))  # type: ignore[attr-defined]
    time.sleep(0.5)
    return {"opened": str(target)}


@mcp.tool()
def system_info() -> dict:
    """Basic info about this PC: screen size, allowed file roots, models in use."""
    import pyautogui

    width, height = pyautogui.size()
    return {
        "screen": [width, height],
        "allowed_roots": [str(r) for r in ROOTS],
        "vision_model": VISION_MODEL,
        "yolo_model": YOLO_MODEL,
        "confirmations": CONFIRM,
        "home": str(HOME),
    }


if __name__ == "__main__":
    if "--http" in sys.argv:
        mcp.run(
            "streamable-http",
            host="127.0.0.1",
            port=int(os.environ.get("LOCALTOOLS_PORT", "8765")),
        )
    else:
        mcp.run("stdio")
