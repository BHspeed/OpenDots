# Local-only mode

This branch runs OpenDots entirely on your PC. No conversation, file, or screen
data leaves the machine.

| Piece         | Where it runs                                                   |
| ------------- | --------------------------------------------------------------- |
| Model         | Ollama at `127.0.0.1:11434` (default `qwen3-vl:8b`)             |
| Conversations | `data/opendots.sqlite` (`local_threads`, `local_runs`)          |
| Tools         | `localtools/server.py` (MCP), listed in `mcp.servers.json`      |
| Web search    | Disabled by default (`WEB_SEARCH_PROVIDER=disabled`)            |
| Telemetry     | Off (`COPILOTKIT_TELEMETRY_DISABLED=true`, Ultralytics offline) |

Cloud-only features are off: CopilotKit Intelligence, Automatic Learning, Slack,
and OpenAI Realtime voice.

## Start

```powershell
powershell -File start-local.ps1
```

Then open http://127.0.0.1:5173.

## Local tools

`localtools/server.py` is an MCP server shared by every Dot (and usable by any
MCP client):

- **Files**: list, find, read, write, copy, move, Recycle Bin delete
- **Vision**: `describe_image` (describe, OCR, Q&A) on a file or the screen
- **Detection**: `detect_objects` with YOLO11 on the GPU
- **PC control**: screenshots, list/focus windows, click, type, keys, scroll, open

Moving, deleting, overwriting, clicking, typing and opening ask you through a
Windows Yes/No dialog first. File access is limited to `LOCALTOOLS_ROOTS`
(default: your user folder). Outputs (screenshots, detections) go to
`localtools/output/`.

Rebuild its environment:

```powershell
python -m venv localtools\.venv
localtools\.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
localtools\.venv\Scripts\python -m pip install ultralytics mss pyautogui pygetwindow pillow "mcp[cli]" httpx send2trash
```

Run it over HTTP for other apps (for example AJ): `localtools\.venv\Scripts\python localtools\server.py --http`
(serves MCP at `http://127.0.0.1:8765/mcp`).

## Adding capabilities

Add another MCP server to `mcp.servers.json` (`command`/`args` for stdio or
`url` for HTTP). Its tools appear in every Dot as `<server>__<tool>`.

## Settings

| Variable            | Default                     |
| ------------------- | --------------------------- |
| `OPENAI_MODEL`      | `qwen3-vl:8b`               |
| `OPENAI_BASE_URL`   | `http://127.0.0.1:11434/v1` |
| `RUN_TIMEOUT_MS`    | `600000`                    |
| `MAX_OUTPUT_TOKENS` | `8192`                      |
| `MCP_SERVERS_PATH`  | `mcp.servers.json`          |
