# KTHX-OpenAI-Media-Generator

Small local service to launch a visible Playwright browser and persist cookies/storage between restarts.

## Requirements

- Node.js 18+
- Playwright browsers installed

## Setup

```bash
cd KTHX-OpenAI-Media-Generator
pnpm install
pnpm exec playwright install chromium
```

## Run

```bash
# Visible browser with persistent storage in KTHX-OpenAI-Media-Generator/.agent-playwright
PW_HEADLESS=false pnpm start
```

## CLI

Install locally and expose the CLI:

```bash
cd KTHX-OpenAI-Media-Generator
pnpm install
pnpm link --global
```

Start the service:

```bash
generateImage serve
# or
generateFile serve
```

Send a prompt (auto-starts the service if not running):

```bash
generateImage \"Generate an image of a dune worm\"
```

Generate files (auto-detects requested file type and uses a file-oriented starter prompt):

```bash
generateFile \"Create a quarterly revenue report as a PDF\"
generateFile \"Build a customer export csv with columns name,email,plan\"
generateFile \"Make an animated gif of a bouncing logo\"
```

Send a prompt and write images to a custom folder:

```bash
generateImage --dir ./my-images \"Generate an image of a dune worm\"
```

Nested folders are created automatically (relative to your current directory):

```bash
generateImage --dir ./path/path2/path3 \"Generate an image of a dune worm\"
```

`--dir` and `--files` accept Windows (`C:\...`), macOS/Linux (`/Users/...`, `/home/...`), and WSL (`/mnt/c/...`) path styles.
Relative paths are resolved from the directory where you run the command.

You can force behavior with `--mode image|file|auto` on either CLI command.
Use `--stream` to enable stream-first network capture before fallback download handling.
This is opportunistic: images usually stream cleanly, while some file types only expose a clickable download link later, so fallback handling still runs.
When reference uploads are attached, stream capture ignores files whose names match uploaded filenames to avoid treating inputs as generated outputs.
When reference uploads are attached, stream metadata responses with both `file_name` and `file_size_bytes` unset are treated as upload echoes and ignored.
For image mode, each streamed frame is captured in order; frames with metadata `file_name` containing `.partN` are intermediate stream frames, and the final frame is the last one whose metadata `file_name` has no `.partN`.

Upload reference files before generation (comma-separated):

```bash
generateImage --files ./selfie1.png,./selfie2.png \"Create a portrait in this style\"
```

When files are attached for image mode, the prompt is sent as-is (the default `Generate an image of:` prefix is skipped).

Continue from a prior context id with a follow-up answer prompt:

```bash
generateImage --context-id <contextId> --answer \"Add dramatic rim lighting and a blue backdrop\" --sync
```

Continue from a prior context id and upload new reference files for that reply:

```bash
generateImage --context-id <contextId> --answer \"Make this person look older\" --files ./ref1.png,./ref2.png --sync
```

Wait synchronously until the image is fully downloaded:

```bash
generateImage --sync \"Generate an image of a dune worm\"
```

Use stream-first capture for image/file generations:

```bash
generateImage --stream --sync \"Generate an image of a dune worm\"
generateFile --stream --sync \"Create a one-page product summary as PDF\"
```

Read stream events while a non-sync run is in progress:

```bash
# Start async run (returns contextId)
curl -s -X POST http://localhost:4280/open \
  -H 'content-type: application/json' \
  -d '{"url":"https://chatgpt.com","prompt":"Create a gif of a bouncing logo","mode":"file","stream":true,"sync":false}'

# Poll stream events
curl -s "http://localhost:4280/context?id=<contextId>" | jq '.context.streamEvents'
```

Image stream events include per-frame flags you can use to recreate the ChatGPT loading animation:

- `downloadUrl` / `streamFrameUrl` (remote ChatGPT URL for that frame; can be used directly by your client)
- `sourceFileName` (metadata `file_name` from ChatGPT)
- `isStreamPart` (`true` for `.partN` frames)
- `streamPartIndex` (numeric part index when present)
- `isFinalStreamFrame` (`true` when `sourceFileName` has no `.partN`)

`download_url_resolved` events are emitted per frame before local file save, so you can push each incoming frame URL immediately. This works for both:

- async mode (`sync: false`) via `GET /context?id=...` polling
- sync mode (`sync: true`) via the returned `streamEvents` array

For image mode, these per-frame URL events are emitted in both `stream: true` and `stream: false` runs.
Sync image finalization picks the saved file that matches the last `download_url_resolved` frame marked final (`sourceFileName` without `.partN`).

Use sync mode with randomized filenames:

```bash
generateImage --sync --random-name --dir ./my-images \"Generate an image of a dune worm\"
```

Run multiple generations in parallel:

```bash
generateImage --count 3 --sync --random-name \"Generate an image of a dune worm\"
```

Specify a project URL and persist it:

```bash
generateImage open \\
  --prompt \"Generate an image of a neon fox\" \\
  --projectUrl \"https://chatgpt.com/g/g-p-.../project\" \\
  --rememberProject
```

Optional env vars:

- `PW_PORT` (default: `4280`)
- `PW_BROWSER` (`chromium`, `firefox`, `webkit`, default: `chromium`)
- `PW_HEADLESS` (`true`/`false`, default: `false`)
- `PW_HEADLESS_AFTER_AUTH` (`true`/`false`, default: `false`) to auto headless once a session exists
- `PW_HEADLESS_USE_SYSTEM` (`true`/`false`, default: `true`) to force system Chrome/Edge even in headless
- `PW_START_MINIMIZED` (`true`/`false`, default: `true`) to launch headful windows minimized (best effort)
- `PW_HUMANIZE` (`true`/`false`, default: `true`) to enable basic anti-detection tweaks
- `PW_DISABLE_AUTOMATION` (`true`/`false`, default: `true`) to add `--disable-blink-features=AutomationControlled`
- `PW_CHANNEL` (chromium only, e.g. `chrome`)
- `PW_EXECUTABLE_PATH` (full path to a browser binary)
- `PW_PROXY` (proxy server URL, e.g. `http://127.0.0.1:8888`)
- `PW_CHATGPT_PROJECT_URL` (e.g. `https://chatgpt.com/g/g-p-.../project`)
- `PW_CHATGPT_PROJECT_ID` (e.g. `g-p-...-kthx`)
- `PW_PROJECT_DIR` (base folder for session + output; first run prompts if not set)
- `PW_AUTO_HEADFUL_ON_LOGIN` (`true`/`false`, default: `true`) to auto-switch to headful if login/Cloudflare is detected
- `PW_FORCE_PROJECT_PROMPT` (`true`/`false`, default: `false`) to re-prompt for a project folder even if sessions exist
- `PW_STORAGE_DIR` (default: `.agent-playwright`)
- `PW_OUTPUT_DIR` (default: `generations`)
- `PW_DOWNLOADS_DIR` (default: same as `PW_OUTPUT_DIR`; Playwright browser-managed downloads location)
- `PW_PREFER_CURL_DOWNLOADS` (`true`/`false`, default: `true`) for file-mode direct URL fetching via curl before Playwright fallback
- `PW_CURL_TIMEOUT_MS` (default: `25000`) timeout for curl/HTTP file download fetches
- `PW_START_URL` (optional)
- `PW_VIEWPORT` (e.g. `1280x720`)
- `PW_NAV_TIMEOUT_MS` (default: `30000`)
- `PW_WAIT_UNTIL` (default: `domcontentloaded`)
- `PW_IMAGE_IDLE_MS` (default: `8000`)
- `PW_IMAGE_TIMEOUT_MS` (default: `90000`)
- `PW_IMAGE_MAX` (default: `8`)
- `PW_ASYNC_POST_WINDOW_MS` (default: `2500`)
- `PW_USER_AGENT` (override UA string)
- `PW_LOCALE` (e.g. `en-US`)
- `PW_TIMEZONE` (e.g. `America/Los_Angeles`)
- `PW_GEO` (e.g. `37.7749,-122.4194`)
- `PW_PERMISSIONS` (comma-separated, e.g. `geolocation,notifications`)
- `PW_COLOR_SCHEME` (`dark`, `light`, `no-preference`)
- `PW_DEVICE_SCALE` (e.g. `2`)
- `PW_SLOWMO_MS` (e.g. `50`)
- `PW_ARGS` (comma-separated chromium args)

## API

All endpoints are local-only and JSON.

- `GET /health`
- `GET /context?id=<contextId>`
- `POST /open` `{ "url": "https://example.com", "prompt": "...", "mode": "image|file|auto", "stream": true, "command": "generateImage|generateFile", "answerPrompt": "...", "contextId": "ctx-id", "files": ["./selfie1.png", "./selfie2.png"], "prompts": ["...", "..."], "count": 3, "dir": "./my-images", "sync": true, "randomName": true, "projectUrl": "https://chatgpt.com/g/g-p-.../project", "rememberProject": true, "reusePage": false }`
- `POST /goto` `{ "url": "https://example.com" }`
- `POST /close` `{ "scope": "page" | "context" }`

Example:

```bash
curl -X POST http://localhost:4280/open \
  -H 'content-type: application/json' \
  -d '{"url":"https://chat.openai.com","prompt":"Generate an image of a neon fox."}'
```

Cookies, localStorage, and session state are stored in `PW_STORAGE_DIR` so the session survives restarts.

## Notes

- Keep this service on a trusted machine/network only.
- Close with `POST /close` (scope `context`) to flush storage cleanly.
- Humanize mode is best-effort and not a guarantee against detection.
- On first run without session data, you will be prompted for a project folder.
- `PW_STORAGE_DIR` / `PW_OUTPUT_DIR` override the project folder defaults.
- If Chrome/Brave/Edge is installed, the service will auto-detect and use it.
- If you supply a ChatGPT project URL or ID, `/open` will navigate there when the URL is the ChatGPT base.
- Set `rememberProject: true` in `/open` to persist that project URL for future runs.
- With `sync: true`, `/open` waits for downloads and returns `savedFiles`, `metadataIds`, and a full `context` JSON object.
- With non-sync mode, `/open` returns `contextId` and `contextFile`; use `GET /context?id=...` to inspect completion later.
- There is no SSE/WebSocket stream endpoint yet; for live integration, poll `GET /context?id=...` and read `context.streamEvents` plus `context.keepAlive`.
- For `dir`, `files`, `filePaths`, and `file`, the service accepts Windows/macOS/Linux path formats and normalizes them on the host.
- Keep-alive/progress is written to context while running: `keepAlive.lastActivityAt`, `keepAlive.heartbeatSeq`, `keepAlive.lastMetadataId`, `keepAlive.lastOutputPath`, plus `observedMetadataIds`, `observedOutputFiles`, and recent `events`.
- Context now also includes `streamEvents` (rolling history) with structured stream/download capture details such as source, resolved URL, metadata id, saved output path, byte length, failures, and image frame markers (`sourceFileName`, `isStreamPart`, `streamPartIndex`, `isFinalStreamFrame`).
- In sync image runs, `savedFiles` is normalized to one final stable output path (the last captured final frame, i.e. non-`.partN` when available).
- Assistant clarification questions are logged to console and stored in context (`assistantQuestion`, `keepAlive.waitingForUserInput`, `keepAlive.lastAssistantMessage`).
- Assistant generation errors (e.g. image/file generation failures) are captured as `assistantError` and `keepAlive.lastErrorMessage`, and sync runs return `status: "error"` with the message when no file is produced.
- If an assistant generation error is detected before any file is saved, the service retries once automatically before returning an error.
- Use `contextId` + `answerPrompt` in `/open` to continue from a prior run context.
- With `randomName: true`, files are named like `image-<runId>-01.<ext>` or `file-<runId>-01.<ext>` and the response includes `runId`/`plannedFilePrefix`.
- With `count` or `prompts`, `/open` runs multiple generations in parallel and returns a `runs` array.
- With `files`, `/open` uploads local reference files before prompt submission.
- `/open` now uses a new automation page by default; set `reusePage: true` only if you want the same page reused.
- After the download finishes, the page is closed but the browser context stays alive for faster subsequent requests.
- Transient download popup tabs opened during assistant-link capture are closed during the run (not only at final teardown).
- If system Chrome crashes in headless mode, unset `PW_EXECUTABLE_PATH`/`PW_CHANNEL` to fall back to bundled Chromium.
- On macOS, minimizing uses `osascript` and may require Accessibility permissions for the terminal.
