#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, resolve } from "node:path";

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const parseCommaList = (value) => {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const WINDOWS_ABS_PATH_RE = /^[a-zA-Z]:[\\/]/;
const WSL_MOUNT_PATH_RE = /^\/mnt\/([a-zA-Z])\/(.*)$/i;
const CYGDRIVE_PATH_RE = /^\/cygdrive\/([a-zA-Z])\/(.*)$/i;

const stripWrappingQuotes = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const windowsPathToPosixMountPath = (value) => {
  if (!WINDOWS_ABS_PATH_RE.test(value)) return "";
  const normalized = value.replace(/\\/g, "/");
  const drive = normalized.slice(0, 1).toLowerCase();
  const rest = normalized.slice(2).replace(/^\/+/, "");
  return `/mnt/${drive}/${rest}`;
};

const posixMountPathToWindowsPath = (value) => {
  const normalized = value.replace(/\\/g, "/");
  const match =
    WSL_MOUNT_PATH_RE.exec(normalized) || CYGDRIVE_PATH_RE.exec(normalized);
  if (!match) return "";
  const drive = match[1].toUpperCase();
  const rest = (match[2] || "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
};

const isAbsolutePathForAnyPlatform = (value) =>
  isAbsolute(value) || WINDOWS_ABS_PATH_RE.test(value) || value.startsWith("\\\\");

const expandPathCandidates = (value, { baseDir = process.cwd() } = {}) => {
  const raw = stripWrappingQuotes(value);
  if (!raw) return [];

  const ordered = [];
  const seen = new Set();
  const push = (candidate) => {
    if (typeof candidate !== "string") return;
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  if (/^file:\/\//i.test(raw)) {
    try {
      push(fileURLToPath(new URL(raw)));
    } catch {
      // ignore malformed file URLs and continue with raw input
    }
  }

  const hostMapped =
    process.platform === "win32"
      ? posixMountPathToWindowsPath(raw)
      : windowsPathToPosixMountPath(raw);
  if (hostMapped) {
    push(hostMapped);
  }

  push(raw);

  const wslPath = windowsPathToPosixMountPath(raw);
  const windowsPath = posixMountPathToWindowsPath(raw);
  if (wslPath) push(wslPath);
  if (windowsPath) push(windowsPath);

  if (WINDOWS_ABS_PATH_RE.test(raw)) {
    push(raw.replace(/\//g, "\\"));
    push(raw.replace(/\\/g, "/"));
  }

  if (raw.startsWith("\\\\")) {
    push(raw.replace(/\\/g, "/"));
  }

  return ordered.map((candidate) =>
    isAbsolutePathForAnyPlatform(candidate)
      ? candidate
      : resolve(baseDir, candidate),
  );
};

const resolvePathInput = (value, { baseDir = process.cwd() } = {}) => {
  const candidates = expandPathCandidates(value, { baseDir });
  if (candidates.length > 0) {
    return candidates[0];
  }
  return resolve(baseDir, String(value ?? ""));
};

const BOOLEAN_FLAGS = new Set([
  "start",
  "sync",
  "wait",
  "stream",
  "random-name",
  "randomName",
  "rememberProject",
  "setGlobalProject",
]);

const inferCliName = () => {
  const invoked = basename(process.argv[1] || "").toLowerCase();
  if (invoked.startsWith("generatefile")) {
    return "generateFile";
  }
  return "generateImage";
};

const parseArgs = (argv) => {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (key.startsWith("no-")) {
        opts[key.slice(3)] = false;
        continue;
      }
      if (value !== undefined) {
        opts[key] = value;
      } else if (BOOLEAN_FLAGS.has(key)) {
        opts[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        opts[key] = argv[i + 1];
        i += 1;
      } else {
        opts[key] = true;
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
};

const printUsage = (cliName) => {
  console.log(`${cliName} usage:

  ${cliName} serve [--dir PATH]
  ${cliName} open --prompt "..." [--dir PATH] [--files a,b,c] [--context-id ID --answer "..."] [--count N] [--sync] [--stream] [--random-name] [--url https://chatgpt.com] [--projectUrl URL] [--projectId ID] [--rememberProject]
  ${cliName} "your prompt here" [--dir PATH] [--files a,b,c] [--context-id ID --answer "..."] [--count N] [--sync] [--stream] [--random-name]

Options:
  --port            Port for the service (default 4280)
  --dir             Output directory for generated files (Windows/macOS/Linux paths supported)
  --files           Comma-separated file paths to upload before generating (Windows/macOS/Linux paths supported)
  --context-id      Continue from a previous context id
  --answer          Follow-up answer prompt used with --context-id
  --count           Number of parallel generations to start (default 1, max 8)
  --sync / --no-sync  Wait for download completion before command exits
  --stream          Stream-first capture for generated downloads
  --random-name     Use randomized filenames (e.g. image-<run>-01.png or file-<run>-01.pdf)
  --mode            Generation mode: image | file | auto
  --url             Target URL (default: https://chatgpt.com)
  --projectUrl      ChatGPT project URL to open
  --projectId       ChatGPT project ID (g-p-...)
  --rememberProject Persist project URL as global default
  --start / --no-start  Auto-start service if not running (default: start)
`);
};

const main = async () => {
  const cliName = inferCliName();
  const defaultMode = "auto";
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage(cliName);
    process.exit(1);
  }

  const command = argv[0];
  if (command === "serve") {
    const serveOpts = parseArgs(argv.slice(1));
    if (typeof serveOpts.dir === "string" && serveOpts.dir.trim()) {
      process.env.PW_OUTPUT_DIR = resolvePathInput(serveOpts.dir.trim(), {
        baseDir: process.cwd(),
      });
    }
    await import("./server.mjs");
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage(cliName);
    return;
  }

  const opts = parseArgs(argv);
  const port = Number(opts.port || process.env.PW_PORT || 4280);
  const baseUrl = `http://localhost:${port}`;
  const contextId =
    (typeof opts["context-id"] === "string" ? opts["context-id"] : "") ||
    (typeof opts.contextId === "string" ? opts.contextId : "");
  const answerPrompt =
    typeof opts.answer === "string" && opts.answer.trim()
      ? opts.answer.trim()
      : "";
  const positionalPromptParts = command === "open" ? opts._.slice(1) : opts._;
  const optionPrompt =
    typeof opts.prompt === "string" ? opts.prompt : "";
  const prompt =
    optionPrompt ||
    answerPrompt ||
    (positionalPromptParts.length ? positionalPromptParts.join(" ") : "");
  if (!prompt && !contextId) {
    console.error("Missing prompt. Provide --prompt or a positional prompt.");
    process.exit(1);
  }

  const resolvedDir =
    typeof opts.dir === "string" && opts.dir.trim()
      ? resolvePathInput(opts.dir.trim(), { baseDir: process.cwd() })
      : undefined;
  const rawFiles = [
    ...parseCommaList(opts.files),
    ...parseCommaList(opts.file),
  ];
  const resolvedFiles = [
    ...new Set(
      rawFiles.map((entry) =>
        resolvePathInput(entry, { baseDir: process.cwd() }),
      ),
    ),
  ];

  const payload = {
    url: opts.url || "https://chatgpt.com",
    prompt: prompt || undefined,
    mode:
      typeof opts.mode === "string" && opts.mode.trim()
        ? opts.mode.trim()
        : defaultMode,
    contextId: contextId || undefined,
    answerPrompt: contextId && answerPrompt ? answerPrompt : undefined,
    dir: resolvedDir,
    files: resolvedFiles.length ? resolvedFiles : undefined,
    count:
      Number.isInteger(Number(opts.count)) && Number(opts.count) > 0
        ? Number(opts.count)
        : undefined,
    sync: opts.sync === true || opts.wait === true,
    stream: opts.stream === true,
    randomName:
      opts.randomName === true || opts["random-name"] === true,
    projectUrl: opts.projectUrl,
    projectId: opts.projectId,
    rememberProject: Boolean(opts.rememberProject || opts.setGlobalProject),
    command: cliName,
  };

  const shouldStart = opts.start !== false;
  const healthUrl = `${baseUrl}/health`;

  const fetchJson = async (url, options) => {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return response.json();
  };

  const waitForHealth = async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        await fetchJson(healthUrl, { method: "GET" });
        return true;
      } catch {
        await sleep(200 + attempt * 50);
      }
    }
    return false;
  };

  let healthy = await waitForHealth();
  if (!healthy && shouldStart) {
    const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
    const child = spawn(process.execPath, [serverPath], {
      cwd: resolve(process.cwd()),
      env: {
        ...process.env,
        PW_PORT: String(port),
        ...(resolvedDir ? { PW_OUTPUT_DIR: resolvedDir } : {}),
      },
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    healthy = await waitForHealth();
  }

  if (!healthy) {
    console.error(`Service not running. Start it with: ${cliName} serve`);
    process.exit(1);
  }

  const result = await fetchJson(`${baseUrl}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
