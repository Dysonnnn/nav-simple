# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project Overview

Personal navigation/homepage app: Python stdlib single-file backend (`nav_web.py`, zero third-party dependencies) + jQuery 3.7.1 frontend (`static/`, vendored locally, no CDN). Listens on **127.0.0.1:18081** by default. It coexists with a separate React version (`/root/tools/nav`, port 18080); feature parity with that version is intentional — when changing config validation or behavior, keep it aligned with the React version's `isValidConfig` and feature set. No build step, no test suite, no linter configured.

Deployment target is Termux (Android): production is managed by runit (`termux-services`, service `nav-py`) and starts via `~/.termux/boot/start-nav-py.sh`.

## Commands

```sh
python3 nav_web.py run       # foreground (for runit/supervisor); Ctrl+C to stop
python3 nav_web.py start     # daemonize (default 127.0.0.1:18081)
python3 nav_web.py stop | restart | status

python3 -m py_compile nav_web.py   # syntax check (only "lint" available)
```

`--bind 0.0.0.0` exposes unauthenticated write endpoints to the LAN — avoid.

## Architecture

Three flat layers, all writes go back to files on disk:

- **`nav_web.py`** — the entire backend. `BaseHTTPRequestHandler` subclass `Handler` does routing in `do_GET/do_PUT/do_POST/do_PATCH` (no framework). Also contains daemon management (`start/stop/status` via pid file + signals) and two file-backed stores: config and feedback.
- **`static/`** — frontend served from disk. `app.js` (single file, ordered sections: utils / api / icons / ping / theme / router / render / editor / feedback / keyboard / init) talks to the API via `api` object; `index.html` + `app.css` + `vendor/jquery.min.js`.
- **`config.json`** — navigation data (`title`, `settings`, `groups[].sites[]`); edits from the UI's editor are saved back to this file directly (this is the key difference from the React version, which only stores localStorage drafts). **`runtime/`** (gitignored) holds pid, log, `feedback.json`, and `backups/` (config backups, keep 10).

### Write-path invariants (config + feedback)

Every write follows the same three guarantees — preserve them in any change:

1. `threading.Lock` (`_CFG_LOCK` / `_FB_LOCK`) serializes read-modify-write cycles.
2. `atomic_write_json`: temp file in same dir + `os.replace` (crash-safe).
3. Config writes call `backup_config()` first (timestamped backup, rotate 10).

### Security conventions (XSS)

- All user-provided text is rendered with jQuery `.text()` / `esc()` in `app.js` — never concatenate user data into HTML strings.
- Feedback is sanitized server-side via `strip_tags` before storage; replies too (PATCH handler).
- Site icons: only monochrome SVG (grayscale check) may go through `sanitizeSvg()` then `innerHTML`; colored icons are rendered as data URIs.
- `/static/` serving does realpath containment check (path traversal guard).

### API error shape

All API responses are `{"ok": bool, "data" | "error": {code, msg}}`; frontend unwraps via `apiErrorText()`. Feedback list filtering is intentionally lenient (unknown `status` values treated as `all` rather than 422).
