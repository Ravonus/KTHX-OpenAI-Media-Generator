#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const parseCommaList = (value) => {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
  --dir             Output directory for generated files
  --files           Comma-separated file paths to upload before generating
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
      process.env.PW_OUTPUT_DIR = resolve(process.cwd(), serveOpts.dir.trim());
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
      ? resolve(process.cwd(), opts.dir.trim())
      : undefined;
  const rawFiles = [
    ...parseCommaList(opts.files),
    ...parseCommaList(opts.file),
  ];
  const resolvedFiles = [
    ...new Set(rawFiles.map((entry) => resolve(process.cwd(), entry))),
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
