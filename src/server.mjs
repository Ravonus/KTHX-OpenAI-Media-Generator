import http from "node:http";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { chromium, firefox, webkit } from "playwright";

const boolFromEnv = (key, fallback) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const numberFromEnv = (key, fallback) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseViewport = (value) => {
  if (!value) return null;
  const [widthRaw, heightRaw] = value.split("x");
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
};

const parseGeolocation = (value) => {
  if (!value) return null;
  const [latRaw, lonRaw] = value.split(",");
  const latitude = Number(latRaw);
  const longitude = Number(lonRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
};

const parseArgs = (value) => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const sleep = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const MIME_EXTENSION_MAP = Object.freeze({
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/csv": ".csv",
  "application/csv": ".csv",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
});

const normalizeContentType = (contentType) => {
  if (typeof contentType !== "string") return "";
  return contentType.split(";")[0].trim().toLowerCase();
};

const extensionFromContentType = (contentType) => {
  const normalized = normalizeContentType(contentType);
  if (!normalized) return "";
  const mapped = MIME_EXTENSION_MAP[normalized];
  if (mapped) return mapped;
  const [type, subtype] = normalized.split("/");
  if (!type || !subtype) return "";
  const simplifiedSubtype = subtype.split("+")[0];
  if (!simplifiedSubtype) return "";
  if (type === "image" && /^[a-z0-9-]+$/i.test(simplifiedSubtype)) {
    return `.${simplifiedSubtype.toLowerCase()}`;
  }
  if (type === "text" && simplifiedSubtype === "csv") {
    return ".csv";
  }
  return "";
};

const parseContentDispositionFileName = (headerValue) => {
  if (typeof headerValue !== "string" || !headerValue) return "";
  const utf8Match = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      // ignore malformed encoding
    }
  }
  const quotedMatch = /filename\s*=\s*"([^"]+)"/i.exec(headerValue);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const plainMatch = /filename\s*=\s*([^;]+)/i.exec(headerValue);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return "";
};

const isJsonContentType = (contentType) =>
  normalizeContentType(contentType) === "application/json";

const config = {
  port: numberFromEnv("PW_PORT", numberFromEnv("PORT", 4280)),
  storageDir: resolve(
    process.cwd(),
    process.env.PW_STORAGE_DIR ?? ".agent-playwright",
  ),
  storageDirFromEnv: Boolean(process.env.PW_STORAGE_DIR),
  outputDir: resolve(process.cwd(), process.env.PW_OUTPUT_DIR ?? "generations"),
  outputDirFromEnv: Boolean(process.env.PW_OUTPUT_DIR),
  headlessInitial: boolFromEnv("PW_HEADLESS", false),
  headlessAfterAuth: boolFromEnv("PW_HEADLESS_AFTER_AUTH", false),
  headless: boolFromEnv("PW_HEADLESS", false),
  headlessUseSystem: boolFromEnv("PW_HEADLESS_USE_SYSTEM", true),
  startMinimized: boolFromEnv("PW_START_MINIMIZED", true),
  browser: (process.env.PW_BROWSER ?? "chromium").toLowerCase(),
  humanize: boolFromEnv("PW_HUMANIZE", true),
  disableAutomation: boolFromEnv("PW_DISABLE_AUTOMATION", true),
  channel: process.env.PW_CHANNEL ?? "",
  executablePath: process.env.PW_EXECUTABLE_PATH ?? "",
  proxyServer: process.env.PW_PROXY ?? "",
  startUrl: process.env.PW_START_URL ?? "",
  waitUntil: process.env.PW_WAIT_UNTIL ?? "domcontentloaded",
  navTimeoutMs: numberFromEnv("PW_NAV_TIMEOUT_MS", 30_000),
  imageIdleMs: numberFromEnv("PW_IMAGE_IDLE_MS", 8_000),
  imageTimeoutMs: numberFromEnv("PW_IMAGE_TIMEOUT_MS", 90_000),
  imageMax: numberFromEnv("PW_IMAGE_MAX", 8),
  asyncPostWindowMs: numberFromEnv("PW_ASYNC_POST_WINDOW_MS", 2_500),
  acceptDownloads: boolFromEnv("PW_ACCEPT_DOWNLOADS", true),
  viewport: parseViewport(process.env.PW_VIEWPORT ?? ""),
  userAgent: process.env.PW_USER_AGENT ?? "",
  locale: process.env.PW_LOCALE ?? "",
  timezoneId: process.env.PW_TIMEZONE ?? "",
  geolocation: parseGeolocation(process.env.PW_GEO ?? ""),
  permissions: process.env.PW_PERMISSIONS
    ? process.env.PW_PERMISSIONS.split(",").map((entry) => entry.trim())
    : [],
  colorScheme: process.env.PW_COLOR_SCHEME ?? "",
  deviceScaleFactor: numberFromEnv("PW_DEVICE_SCALE", 0),
  slowMoMs: numberFromEnv("PW_SLOWMO_MS", 0),
  extraArgs: parseArgs(process.env.PW_ARGS ?? ""),
  projectDir: process.env.PW_PROJECT_DIR
    ? resolve(process.cwd(), process.env.PW_PROJECT_DIR)
    : null,
  forceProjectPrompt: boolFromEnv("PW_FORCE_PROJECT_PROMPT", false),
  chatGptProjectUrl: process.env.PW_CHATGPT_PROJECT_URL ?? "",
  chatGptProjectId: process.env.PW_CHATGPT_PROJECT_ID ?? "",
  autoHeadfulOnLogin: boolFromEnv("PW_AUTO_HEADFUL_ON_LOGIN", true),
};

const browsers = {
  chromium,
  firefox,
  webkit,
};

const LOCAL_CONFIG_DIR = resolve(process.cwd(), ".agent-playwright");
const LOCAL_CONFIG_PATH = resolve(LOCAL_CONFIG_DIR, "config.json");
const CONTEXT_RUNS_DIR = resolve(LOCAL_CONFIG_DIR, "runs");

let context = null;
let page = null;
let contextStarting = null;
let configReady = false;
let headfulRelaunchUsed = false;
let minimizeScheduled = false;

const ensureStorageDir = async () => {
  await mkdir(config.storageDir, { recursive: true });
};

const ensureOutputDir = async () => {
  await mkdir(config.outputDir, { recursive: true });
};

const ensureContextRunsDir = async () => {
  await mkdir(CONTEXT_RUNS_DIR, { recursive: true });
};

const contextRunPath = (id) => resolve(CONTEXT_RUNS_DIR, `${id}.json`);

const sanitizeContextId = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "");
};

const loadContextRun = async (id) => {
  const safeId = sanitizeContextId(id);
  if (!safeId) return null;
  const filePath = contextRunPath(safeId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const persistContextRun = async (record) => {
  const safeId = sanitizeContextId(record?.id);
  if (!safeId) return null;
  await ensureContextRunsDir();
  const nowIso = new Date().toISOString();
  const payload = {
    ...(record ?? {}),
    id: safeId,
    updatedAt: nowIso,
  };
  if (!payload.createdAt) {
    payload.createdAt = nowIso;
  }
  const filePath = contextRunPath(safeId);
  await writeFile(filePath, JSON.stringify(payload, null, 2));
  return { payload, filePath };
};

const setOutputDir = async (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return config.outputDir;
  config.outputDir = resolve(process.cwd(), trimmed);
  await ensureOutputDir();
  return config.outputDir;
};

const hasSessionData = async (dir) => {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
};

const promptForProjectDir = async () => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(
    `Project folder for agent sessions (default: ${process.cwd()}): `,
  );
  rl.close();
  const trimmed = answer.trim();
  if (!trimmed) return null;
  return resolve(trimmed);
};

const detectBrowserExecutable = () => {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "";
    candidates.push(
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${programFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${programFilesX86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/brave-browser",
      "/snap/bin/chromium",
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const runAppleScript = async (lines) =>
  new Promise((resolvePromise) => {
    execFile("osascript", ["-e", lines.join("\n")], () => resolvePromise());
  });

const minimizeMacAppWindow = async () => {
  if (process.platform !== "darwin") return;
  if (!config.startMinimized || config.headless) return;
  const names = [];
  if (config.executablePath) {
    if (config.executablePath.includes("Google Chrome")) {
      names.push("Google Chrome");
    }
    if (config.executablePath.includes("Chromium")) {
      names.push("Chromium");
    }
    if (config.executablePath.includes("Brave Browser")) {
      names.push("Brave Browser");
    }
    if (config.executablePath.includes("Microsoft Edge")) {
      names.push("Microsoft Edge");
    }
  }
  names.push("Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge");
  for (const appName of new Set(names)) {
    await runAppleScript([
      'tell application "System Events"',
      `  tell application process "${appName}"`,
      "    if (count of windows) > 0 then",
      "      set value of attribute \"AXMinimized\" of window 1 to true",
      "    end if",
      "  end tell",
      "end tell",
    ]);
  }
};

const scheduleMinimize = () => {
  if (minimizeScheduled) return;
  minimizeScheduled = true;
  setTimeout(() => {
    minimizeMacAppWindow().catch(() => undefined);
  }, 800);
};

const buildChatGptProjectUrl = (value) => {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  const normalized = trimmed.replace(/^\/+/, "");
  if (normalized.startsWith("g/")) {
    return `https://chatgpt.com/${normalized.replace(/\/+$/, "")}`;
  }
  if (normalized.includes("/")) {
    return `https://chatgpt.com/${normalized.replace(/\/+$/, "")}`;
  }
  return `https://chatgpt.com/g/${normalized}/project`;
};

const persistLocalConfig = async () => {
  try {
    await mkdir(LOCAL_CONFIG_DIR, { recursive: true });
    await writeFile(
      LOCAL_CONFIG_PATH,
      JSON.stringify(
        {
          projectDir: config.projectDir,
          chatGptProjectUrl: config.chatGptProjectUrl || null,
          chatGptProjectId: config.chatGptProjectId || null,
        },
        null,
        2,
      ),
    );
  } catch {
    // ignore write failures
  }
};

const ensureConfig = async () => {
  if (configReady) return;
  configReady = true;

  let storedProjectDir = null;
  let storedChatGptProjectUrl = null;
  let storedChatGptProjectId = null;
  if (existsSync(LOCAL_CONFIG_PATH)) {
    try {
      const contents = await readFile(LOCAL_CONFIG_PATH, "utf8");
      const parsed = JSON.parse(contents);
      storedProjectDir =
        typeof parsed?.projectDir === "string" ? parsed.projectDir : null;
      storedChatGptProjectUrl =
        typeof parsed?.chatGptProjectUrl === "string"
          ? parsed.chatGptProjectUrl
          : null;
      storedChatGptProjectId =
        typeof parsed?.chatGptProjectId === "string"
          ? parsed.chatGptProjectId
          : null;
    } catch {
      // ignore config read failures
    }
  }

  let projectDir = config.projectDir ?? storedProjectDir;
  const defaultStorageDir = resolve(process.cwd(), ".agent-playwright");
  const hasDefaultSession = await hasSessionData(defaultStorageDir);
  if (
    config.forceProjectPrompt ||
    (!projectDir && !config.storageDirFromEnv && !hasDefaultSession)
  ) {
    projectDir = await promptForProjectDir();
  }
  if (!projectDir) {
    projectDir = process.cwd();
  }

  config.projectDir = projectDir;
  if (!config.storageDirFromEnv) {
    config.storageDir = resolve(projectDir, ".agent-playwright");
  }
  if (!config.outputDirFromEnv) {
    config.outputDir = resolve(projectDir, "generations");
  }

  if (!config.chatGptProjectUrl && !config.chatGptProjectId) {
    if (storedChatGptProjectUrl) {
      config.chatGptProjectUrl = storedChatGptProjectUrl;
    } else if (storedChatGptProjectId) {
      config.chatGptProjectId = storedChatGptProjectId;
    }
  }

  if (!config.chatGptProjectUrl && config.chatGptProjectId) {
    config.chatGptProjectUrl = buildChatGptProjectUrl(
      config.chatGptProjectId,
    );
  }

  await persistLocalConfig();

  const hasSession = await hasSessionData(config.storageDir);
  config.headless = hasSession
    ? config.headlessAfterAuth
    : config.headlessInitial;

  if (
    config.browser === "chromium" &&
    !config.executablePath &&
    !config.channel
  ) {
    const detected = detectBrowserExecutable();
    if (detected) {
      config.executablePath = detected;
      config.browser = "chromium";
      console.log("Detected browser executable:", detected);
    }
  }
};

const sanitizeFileName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const applyExtension = (fileName, ext) => {
  if (!ext) return fileName;
  const currentExt = extname(fileName);
  if (currentExt) return fileName;
  return `${fileName}${ext}`;
};

const buildSaveResult = (
  savedCount = 0,
  savedFiles = [],
  metadataIds = [],
  streamEvents = [],
) => ({
  savedCount,
  savedFiles,
  metadataIds: [...new Set(metadataIds.filter(Boolean))],
  streamEvents: streamEvents.filter(Boolean),
});

const mergeSaveResults = (base, extra) => {
  if (!extra) return base;
  return buildSaveResult(
    (base.savedCount ?? 0) + (extra.savedCount ?? 0),
    [...(base.savedFiles ?? []), ...(extra.savedFiles ?? [])],
    [...(base.metadataIds ?? []), ...(extra.metadataIds ?? [])],
    [...(base.streamEvents ?? []), ...(extra.streamEvents ?? [])],
  );
};

const createImageRun = (
  { randomizeFileNames = false, generationMode = "image" } = {},
) => {
  const normalizedMode = generationMode === "file" ? "file" : "image";
  return {
    runId: randomUUID().split("-")[0],
    randomizeFileNames,
    nextFileIndex: 1,
    generationMode: normalizedMode,
    filePrefix: normalizedMode === "file" ? "file" : "image",
  };
};

const nextRandomBaseName = (imageRun) => {
  const index = String(imageRun.nextFileIndex).padStart(2, "0");
  imageRun.nextFileIndex += 1;
  return `${imageRun.filePrefix || "image"}-${imageRun.runId}-${index}`;
};

const saveBufferToDisk = async (
  buffer,
  { fileName, contentType, metadataId = null, imageRun = null },
) => {
  await ensureOutputDir();
  const ext = extensionFromContentType(contentType);
  const normalizedName =
    typeof fileName === "string" && fileName.trim()
      ? basename(fileName.trim())
      : "";
  const baseName =
    imageRun?.randomizeFileNames === true
      ? nextRandomBaseName(imageRun)
      : normalizedName ||
        `${imageRun?.filePrefix || "download"}-${Date.now()}`;
  let safeName = sanitizeFileName(baseName);
  safeName = applyExtension(safeName, ext);
  const filePath = resolve(config.outputDir, safeName);
  await writeFile(filePath, buffer);
  console.log("Saved file:", filePath);
  return {
    filePath,
    fileName: basename(filePath),
    byteLength: buffer?.byteLength ?? 0,
    contentType,
    metadataId,
  };
};

const fetchDownloadWithRetry = async (request, url, attempts = 4) => {
  let lastStatus = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await request.get(url);
    lastStatus = response.status();
    const contentType = response.headers()["content-type"] ?? "";
    if (response.ok() && !isJsonContentType(contentType)) {
      const buffer = await response.body();
      const disposition = response.headers()["content-disposition"] ?? "";
      return {
        buffer,
        contentType,
        status: response.status(),
        fileName: parseContentDispositionFileName(disposition),
      };
    }
    const preview = await response.text();
    console.warn(
      `Download attempt ${attempt}/${attempts} returned ${response.status()} (${contentType}).`,
    );
    if (preview) {
      console.warn("Download response preview:", preview.slice(0, 200));
    }
    if (attempt < attempts) {
      await sleep(1000 * attempt);
    }
  }
  throw new Error(
    `Download failed after ${attempts} attempts. Last status: ${lastStatus}`,
  );
};

const saveDownloadFromUrl = async (
  pageInstance,
  url,
  { imageRun = null } = {},
) => {
  const response = await pageInstance.request.get(url);
  const contentType = response.headers()["content-type"] ?? "";
  const initialMetadataId = extractFileId(url);
  if (isJsonContentType(contentType)) {
    const fileInfo = await response.json();
    console.log("Received file download metadata:", fileInfo);
    if (fileInfo?.detail?.message) {
      console.warn("Download metadata error:", fileInfo.detail.message);
      return buildSaveResult();
    }
    const downloadUrl = fileInfo?.download_url;
    if (typeof downloadUrl !== "string" || !downloadUrl) {
      console.warn("download_url missing from metadata response");
      return buildSaveResult();
    }
    const metadataId = extractFileId(downloadUrl) || initialMetadataId || null;
    const fileName =
      typeof fileInfo?.file_name === "string"
        ? basename(fileInfo.file_name)
        : null;
    return saveDownloadRecord(
      pageInstance,
      {
        downloadUrl,
        fileName,
        metadataId,
      },
      { imageRun },
    );
  }

  if (!isJsonContentType(contentType)) {
    const buffer = await response.body();
    const metadataId = extractFileId(url) || null;
    const nameCandidate =
      parseContentDispositionFileName(
        response.headers()["content-disposition"] ?? "",
      ) ||
      (metadataId
        ? `${imageRun?.filePrefix || "download"}-${metadataId}`
        : `${imageRun?.filePrefix || "download"}-${Date.now()}`);
    const saved = await saveBufferToDisk(buffer, {
      fileName: nameCandidate,
      contentType,
      metadataId,
      imageRun,
    });
    return buildSaveResult(1, [saved], metadataId ? [metadataId] : []);
  }

  const preview = await response.text();
  console.warn("Unexpected download content-type:", contentType);
  if (preview) {
    console.warn("Download response preview:", preview.slice(0, 200));
  }
  return buildSaveResult();
};

const isLikelyAssistantDownloadUrl = (value) => {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (/chatgpt\.com$|chat\.openai\.com$/i.test(host)) {
      return (
        parsed.pathname.includes("/files/") ||
        parsed.pathname.startsWith("/backend-api/estuary/content/")
      );
    }
    if (
      /oaiusercontent\.com$|openaiusercontent\.com$|oaistatic\.com$/i.test(host)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

const isLikelyDownloadResponseUrl = (value) => {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (/chatgpt\.com$|chat\.openai\.com$/i.test(host)) {
      return (
        parsed.pathname.startsWith("/backend-api/files/download/") ||
        parsed.pathname.startsWith("/backend-api/estuary/content/") ||
        parsed.pathname.includes("/files/")
      );
    }
    if (
      /oaiusercontent\.com$|openaiusercontent\.com$|oaistatic\.com$/i.test(host)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

const resolvePageFromRequest = (request) => {
  try {
    const frame =
      request && typeof request.frame === "function" ? request.frame() : null;
    if (!frame || typeof frame.page !== "function") return null;
    return frame.page();
  } catch {
    return null;
  }
};

const resolvePageFromResponse = (response) => {
  try {
    const frame =
      response && typeof response.frame === "function" ? response.frame() : null;
    if (!frame || typeof frame.page !== "function") return null;
    return frame.page();
  } catch {
    return null;
  }
};

const savePlaywrightDownload = async (download, { imageRun = null } = {}) => {
  if (!download) return buildSaveResult();
  const suggestedName =
    typeof download.suggestedFilename === "function"
      ? download.suggestedFilename()
      : "";
  let buffer = null;
  try {
    const savedPath = await download.path();
    if (savedPath) {
      buffer = await readFile(savedPath);
    }
  } catch {
    // ignore and fallback to stream
  }
  if (!buffer && typeof download.createReadStream === "function") {
    try {
      const stream = await download.createReadStream();
      if (stream) {
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
      }
    } catch {
      // ignore stream failures
    }
  }
  if (!buffer || buffer.byteLength === 0) {
    return buildSaveResult();
  }
  const sourceUrl =
    typeof download.url === "function" ? download.url() : "";
  const metadataId = sourceUrl ? extractFileId(sourceUrl) : null;
  const saved = await saveBufferToDisk(buffer, {
    fileName:
      (typeof suggestedName === "string" && suggestedName.trim()
        ? suggestedName.trim()
        : "") || `${imageRun?.filePrefix || "download"}-${Date.now()}`,
    contentType: "",
    metadataId,
    imageRun,
  });
  return buildSaveResult(1, [saved], metadataId ? [metadataId] : []);
};

const waitForContextDownloadEvent = async (
  ctx,
  timeoutMs,
  { isPageAllowed = () => true } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    let download = null;
    try {
      download = await ctx.waitForEvent("download", {
        timeout: remainingMs,
      });
    } catch {
      return null;
    }
    if (!download) return null;
    const sourcePage =
      typeof download.page === "function" ? download.page() : null;
    if (!sourcePage || isPageAllowed(sourcePage)) {
      return download;
    }
  }
  return null;
};

const extractLatestAssistantDownloadUrls = async (pageInstance) => {
  const rawUrls = await pageInstance.evaluate(() => {
    const turns = Array.from(document.querySelectorAll('article[data-turn="assistant"]'));
    const latestTurn = turns[turns.length - 1];
    if (!latestTurn) return [];
    const values = [];
    const push = (value) => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (trimmed) values.push(trimmed);
    };
    for (const anchor of latestTurn.querySelectorAll("a[href]")) {
      push(anchor.getAttribute("href"));
    }
    for (const node of latestTurn.querySelectorAll("[data-url]")) {
      push(node.getAttribute("data-url"));
    }
    for (const node of latestTurn.querySelectorAll("[data-href]")) {
      push(node.getAttribute("data-href"));
    }
    return values;
  });
  const normalized = [
    ...new Set(
      rawUrls
        .map((entry) => {
          try {
            return new URL(entry, "https://chatgpt.com").toString();
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ];
  return normalized.filter((candidate) => isLikelyAssistantDownloadUrl(candidate));
};

const collectAssistantDownloadsByClick = async (
  pageInstance,
  {
    imageRun = null,
    attemptedControlKeys = new Set(),
    timeoutMs = 8_000,
    isPageAllowed = () => true,
  } = {},
) => {
  const shouldAcceptUnknownPageEvent = () => {
    try {
      const allowedPages = pageInstance
        .context()
        .pages()
        .filter((candidatePage) => isPageAllowed(candidatePage));
      return allowedPages.length <= 1;
    } catch {
      return false;
    }
  };
  let result = buildSaveResult();
  const turns = pageInstance.locator('article[data-turn="assistant"]');
  const turnCount = await turns.count();
  if (!turnCount) return result;

  const startTurnIndex = Math.max(0, turnCount - 4);
  for (let turnIndex = turnCount - 1; turnIndex >= startTurnIndex; turnIndex -= 1) {
    const turn = turns.nth(turnIndex);
    const controls = turn.locator("a, button, [role='button']");
    const controlCount = await controls.count();
    for (let index = 0; index < controlCount; index += 1) {
      const control = controls.nth(index);
      const isVisible = await control.isVisible().catch(() => false);
      if (!isVisible) continue;
      const text = normalizeWhitespace(
        (await control
          .innerText()
          .catch(() => control.textContent().catch(() => ""))) || "",
      );
      if (!/\bdownload\b/i.test(text)) continue;
      const hrefRaw = await control.getAttribute("href").catch(() => null);
      const href = typeof hrefRaw === "string" ? hrefRaw.trim() : "";
      const key = `${turnIndex}:${text || "(download-control)"}::${href || index}`;
      if (attemptedControlKeys.has(key)) continue;
      attemptedControlKeys.add(key);

      if (href) {
        try {
          const resolved = new URL(href, pageInstance.url()).toString();
          if (isLikelyAssistantDownloadUrl(resolved)) {
            const next = await saveDownloadFromUrl(pageInstance, resolved, {
              imageRun,
            });
            result = mergeSaveResults(result, next);
            if ((result.savedCount ?? 0) > 0) {
              return result;
            }
          }
        } catch {
          // continue to click fallback
        }
      }

      const responsePromise = pageInstance
        .context()
        .waitForEvent("response", {
          predicate: (response) => {
            if (!isLikelyDownloadResponseUrl(response.url())) return false;
            const eventPage = resolvePageFromResponse(response);
            if (!eventPage) return shouldAcceptUnknownPageEvent();
            return isPageAllowed(eventPage);
          },
          timeout: Math.max(2_000, timeoutMs),
        })
        .catch(() => null);
      const requestPromise = pageInstance
        .context()
        .waitForEvent("request", {
          predicate: (request) => {
            if (!isLikelyDownloadResponseUrl(request.url())) return false;
            const eventPage = resolvePageFromRequest(request);
            if (!eventPage) return shouldAcceptUnknownPageEvent();
            return isPageAllowed(eventPage);
          },
          timeout: Math.max(2_000, timeoutMs),
        })
        .catch(() => null);
      const contextDownloadPromise = waitForContextDownloadEvent(
        pageInstance.context(),
        Math.max(2_000, timeoutMs),
        { isPageAllowed },
      );

      try {
        await control.scrollIntoViewIfNeeded().catch(() => undefined);
        await control.click({
          timeout: 4_000,
          force: true,
          noWaitAfter: true,
        });
      } catch (error) {
        try {
          await control.evaluate((node) => node.click());
        } catch {
          console.warn(
            "Failed to click assistant download control:",
            text || "(no text)",
            error,
          );
          continue;
        }
      }

      const [downloadResponse, downloadRequest, downloadEvent] = await Promise.all([
        responsePromise,
        requestPromise,
        contextDownloadPromise,
      ]);

      if (downloadEvent) {
        const next = await savePlaywrightDownload(downloadEvent, { imageRun });
        result = mergeSaveResults(result, next);
        if ((result.savedCount ?? 0) > 0) {
          return result;
        }
      }

      if (!downloadResponse) {
        if (downloadRequest) {
          let next = buildSaveResult();
          try {
            next = await saveDownloadFromUrl(pageInstance, downloadRequest.url(), {
              imageRun,
            });
          } catch (error) {
            console.warn(
              "Failed to save from clicked download request:",
              downloadRequest.url(),
              error,
            );
          }
          result = mergeSaveResults(result, next);
          if ((result.savedCount ?? 0) > 0) {
            return result;
          }
        }
        continue;
      }
      const responseType = downloadResponse.headers()["content-type"] ?? "";
      if (isJsonContentType(responseType)) {
        let next = buildSaveResult();
        try {
          next = await saveDownloadFromUrl(pageInstance, downloadResponse.url(), {
            imageRun,
          });
        } catch (error) {
          console.warn(
            "Failed to save from clicked metadata response:",
            downloadResponse.url(),
            error,
          );
        }
        result = mergeSaveResults(result, next);
        if ((result.savedCount ?? 0) > 0) {
          return result;
        }
        continue;
      }
      const metadataId = extractFileId(downloadResponse.url()) || null;
      const contentDisposition =
        downloadResponse.headers()["content-disposition"] ?? "";
      const fileNameHint =
        parseContentDispositionFileName(contentDisposition) ||
        (metadataId
          ? `${imageRun?.filePrefix || "download"}-${metadataId}`
          : `${imageRun?.filePrefix || "download"}-${Date.now()}`);
      let next = buildSaveResult();
      try {
        next = await saveDownloadRecord(
          pageInstance,
          {
            downloadUrl: downloadResponse.url(),
            fileName: fileNameHint,
            metadataId,
          },
          { imageRun },
        );
      } catch (error) {
        console.warn(
          "Failed to save from clicked download response:",
          downloadResponse.url(),
          error,
        );
      }
      result = mergeSaveResults(result, next);
      if ((result.savedCount ?? 0) > 0) {
        return result;
      }
    }
  }
  return result;
};

const collectAssistantDownloadsAfterCompletion = async (
  pageInstance,
  { imageRun = null, timeoutMs = 18_000, isPageAllowed = () => true } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  const attemptedUrls = new Set();
  const attemptedControlKeys = new Set();
  let result = buildSaveResult();
  while (Date.now() < deadline) {
    const candidates = await extractLatestAssistantDownloadUrls(pageInstance);
    for (const candidate of candidates) {
      if (attemptedUrls.has(candidate)) continue;
      attemptedUrls.add(candidate);
      try {
        const next = await saveDownloadFromUrl(pageInstance, candidate, {
          imageRun,
        });
        result = mergeSaveResults(result, next);
      } catch (error) {
        console.warn(
          "Failed to fetch assistant download candidate:",
          candidate,
          error,
        );
      }
    }
    const clicked = await collectAssistantDownloadsByClick(pageInstance, {
      imageRun,
      attemptedControlKeys,
      timeoutMs: Math.max(2_500, Math.min(8_000, timeoutMs / 2)),
      isPageAllowed,
    });
    result = mergeSaveResults(result, clicked);
    if ((result.savedCount ?? 0) > 0) {
      return result;
    }
    await sleep(700);
  }
  return result;
};

const saveDownloadRecord = async (pageInstance, record, { imageRun = null } = {}) => {
  if (!record) return buildSaveResult();
  const metadataId =
    record.metadataId ||
    (typeof record.downloadUrl === "string"
      ? extractFileId(record.downloadUrl)
      : null) ||
    (typeof record.url === "string" ? extractFileId(record.url) : null);
  if (record.buffer) {
    const saved = await saveBufferToDisk(record.buffer, {
      fileName: record.fileName ?? `download-${Date.now()}`,
      contentType: record.contentType ?? "",
      metadataId,
      imageRun,
    });
    return buildSaveResult(1, [saved], metadataId ? [metadataId] : []);
  }
  if (record.downloadUrl) {
    const {
      buffer,
      contentType,
      fileName: fetchedFileName,
    } = await fetchDownloadWithRetry(
      pageInstance.request,
      record.downloadUrl,
    );
    const saved = await saveBufferToDisk(buffer, {
      fileName:
        record.fileName ||
        fetchedFileName ||
        `${imageRun?.filePrefix || "download"}-${Date.now()}`,
      contentType,
      metadataId,
      imageRun,
    });
    return buildSaveResult(1, [saved], metadataId ? [metadataId] : []);
  }
  return buildSaveResult();
};

const extractFileId = (url) => {
  const responseUrl = new URL(url);
  const idParam = responseUrl.searchParams.get("id");
  if (idParam) return idParam;
  if (responseUrl.pathname.startsWith("/backend-api/files/download/")) {
    const parts = responseUrl.pathname.split("/");
    return parts[parts.length - 1] || null;
  }
  return null;
};

const extractConversationId = (url) => {
  const responseUrl = new URL(url);
  if (responseUrl.pathname.startsWith("/backend-api/conversation/")) {
    const parts = responseUrl.pathname.split("/");
    const index = parts.indexOf("conversation");
    if (index >= 0 && parts[index + 1]) {
      return parts[index + 1];
    }
  }
  return responseUrl.searchParams.get("conversation_id");
};

const collectChatGptDownloads = async (
  pageInstance,
  {
    timeoutMs = 60_000,
    idleMs = 3_000,
    maxFiles = 4,
    imageRun = null,
    onStreamEvent = () => undefined,
  } = {},
) => {
  let savedCount = 0;
  let idleTimer = null;
  let timeoutTimer = null;
  let finished = false;
  const seen = new Set();
  const metadataIds = new Set();
  const savedFiles = [];
  const streamEvents = [];
  let queue = Promise.resolve();

  const emitStreamEvent = (event) => {
    if (!event || typeof event !== "object") return;
    const entry = { ...event };
    if (!entry.ts) {
      entry.ts = new Date().toISOString();
    }
    streamEvents.push(entry);
    Promise.resolve(onStreamEvent(entry)).catch(() => undefined);
  };

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    pageInstance.off("response", onResponse);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
  };

  const scheduleIdleCheck = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (savedCount === 0) return;
    idleTimer = setTimeout(() => finish(), idleMs);
  };

  const handleFileBuffer = async (
    buffer,
    contentType,
    nameHint,
    metadataId = null,
    eventMeta = {},
  ) => {
    const saved = await saveBufferToDisk(buffer, {
      fileName: nameHint || `download-${Date.now()}`,
      contentType,
      metadataId,
      imageRun,
    });
    emitStreamEvent({
      type: "file_saved",
      source: eventMeta.source || "stream_response",
      responseUrl: eventMeta.responseUrl || null,
      downloadUrl: eventMeta.downloadUrl || null,
      metadataId: metadataId || null,
      contentType: contentType || null,
      fileName: saved?.fileName || null,
      outputPath: saved?.filePath || null,
      byteLength: saved?.byteLength ?? buffer?.byteLength ?? null,
      message: `Saved ${saved?.fileName || "download"}`,
    });
    savedFiles.push(saved);
    if (metadataId) {
      metadataIds.add(metadataId);
    }
    savedCount += 1;
    if (savedCount >= maxFiles) {
      finish();
    } else {
      scheduleIdleCheck();
    }
  };

  const processResponse = async (response) => {
    const responseUrl = new URL(response.url());
    if (responseUrl.hostname !== "chatgpt.com") return;
    const pathname = responseUrl.pathname;
    const isEstuary = pathname.startsWith("/backend-api/estuary/content");
    const isDownload = pathname.startsWith("/backend-api/files/download/");
    if (!isEstuary && !isDownload) return;

    const responseFileId = extractFileId(response.url());
    const dedupeKey = responseFileId || response.url();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const contentType = response.headers()["content-type"] ?? "";
    if (isDownload && isJsonContentType(contentType)) {
      try {
        const fileInfo = await response.json();
        console.log("Received file download metadata:", fileInfo);
        const downloadUrl = fileInfo?.download_url;
        if (typeof downloadUrl === "string" && downloadUrl) {
          const metadataId = extractFileId(downloadUrl) || responseFileId;
          emitStreamEvent({
            type: "download_url_resolved",
            source: "files_download_metadata",
            responseUrl: response.url(),
            downloadUrl,
            metadataId: metadataId || null,
            contentType: contentType || null,
            message: "Resolved download URL from metadata response",
          });
          const {
            buffer,
            contentType: downloadType,
            fileName: fetchedFileName,
          } = await fetchDownloadWithRetry(
            pageInstance.request,
            downloadUrl,
          );
          const nameCandidate =
            typeof fileInfo?.file_name === "string"
              ? basename(fileInfo.file_name)
              : fetchedFileName
                ? basename(fetchedFileName)
                : `${imageRun?.filePrefix || "download"}-${Date.now()}`;
          await handleFileBuffer(
            buffer,
            downloadType,
            nameCandidate,
            metadataId,
            {
              source: "files_download_metadata",
              responseUrl: response.url(),
              downloadUrl,
            },
          );
        } else {
          emitStreamEvent({
            type: "metadata_missing_download_url",
            source: "files_download_metadata",
            responseUrl: response.url(),
            metadataId: responseFileId || null,
            contentType: contentType || null,
            message: "Metadata response did not include download_url",
          });
        }
      } catch (error) {
        console.warn("Failed to process download metadata response:", error);
        emitStreamEvent({
          type: "save_failed",
          source: "files_download_metadata",
          responseUrl: response.url(),
          metadataId: responseFileId || null,
          contentType: contentType || null,
          message: error?.message ?? String(error),
        });
      }
      return;
    }

    if (!isJsonContentType(contentType)) {
      const contentDisposition = response.headers()["content-disposition"] ?? "";
      const fromHeader = parseContentDispositionFileName(contentDisposition);
      const nameHint = fromHeader
        ? basename(fromHeader)
        : responseFileId
          ? `${imageRun?.filePrefix || "download"}-${responseFileId}`
          : `${imageRun?.filePrefix || "download"}-${Date.now()}`;
      let next = buildSaveResult();
      try {
        next = await saveDownloadRecord(
          pageInstance,
          {
            downloadUrl: response.url(),
            fileName: nameHint,
            metadataId: responseFileId || null,
          },
          { imageRun },
        );
      } catch (error) {
        console.warn("Failed to save response download URL:", response.url(), error);
        emitStreamEvent({
          type: "save_failed",
          source: "download_response",
          responseUrl: response.url(),
          metadataId: responseFileId || null,
          contentType: contentType || null,
          message: error?.message ?? String(error),
        });
      }
      savedCount += next.savedCount ?? 0;
      for (const file of next.savedFiles ?? []) {
        savedFiles.push(file);
        emitStreamEvent({
          type: "file_saved",
          source: "download_response",
          responseUrl: response.url(),
          metadataId: responseFileId || null,
          contentType: file?.contentType || contentType || null,
          fileName: file?.fileName || null,
          outputPath: file?.filePath || null,
          byteLength: file?.byteLength ?? null,
          message: `Saved ${file?.fileName || "download"}`,
        });
      }
      for (const id of next.metadataIds ?? []) {
        if (id) metadataIds.add(id);
      }
      if (savedCount >= maxFiles) {
        finish();
      } else if ((next.savedCount ?? 0) > 0) {
        scheduleIdleCheck();
      }
      return;
    }

    if (isEstuary && isJsonContentType(contentType)) {
      try {
        const data = await response.json();
        console.log("Received response from estuary/content:", data);
        const item = data?.item;
        if (!item) {
          emitStreamEvent({
            type: "metadata_missing_item",
            source: "estuary_content",
            responseUrl: response.url(),
            contentType: contentType || null,
            message: "Estuary metadata did not include item id",
          });
          return;
        }
        const downloadUrl = `https://chatgpt.com/backend-api/estuary/content/${item}`;
        emitStreamEvent({
          type: "download_url_resolved",
          source: "estuary_content",
          responseUrl: response.url(),
          downloadUrl,
          metadataId: item,
          contentType: contentType || null,
          message: "Resolved estuary download URL",
        });
        const {
          buffer,
          contentType: downloadType,
          fileName: fetchedFileName,
        } = await fetchDownloadWithRetry(
          pageInstance.request,
          downloadUrl,
        );
        const nameHint = fetchedFileName
          ? basename(fetchedFileName)
          : `${imageRun?.filePrefix || "download"}-${item}`;
        await handleFileBuffer(buffer, downloadType, nameHint, item, {
          source: "estuary_content",
          responseUrl: response.url(),
          downloadUrl,
        });
      } catch (error) {
        console.warn("Failed to process estuary response:", error);
        emitStreamEvent({
          type: "save_failed",
          source: "estuary_content",
          responseUrl: response.url(),
          contentType: contentType || null,
          message: error?.message ?? String(error),
        });
      }
    }
  };

  const onResponse = (response) => {
    if (finished) return;
    queue = queue.catch(() => undefined).then(() => processResponse(response));
  };

  pageInstance.on("response", onResponse);
  timeoutTimer = setTimeout(() => finish(), timeoutMs);

  await new Promise((resolve) => {
    const checkFinished = () => {
      if (finished) {
        resolve();
      } else {
        setTimeout(checkFinished, 250);
      }
    };
    checkFinished();
  });

  await queue;
  if (savedFiles.length > 0) {
    const best = savedFiles.reduce((current, next) =>
      next.byteLength > current.byteLength ? next : current,
    );
    const latestExt = extensionFromContentType(best.contentType);
    const latestName = applyExtension("latest", latestExt);
    const latestPath = resolve(config.outputDir, latestName);
    if (best.filePath !== latestPath) {
      await copyFile(best.filePath, latestPath);
      console.log("Saved latest file:", latestPath);
    }
  }
  emitStreamEvent({
    type: "collector_complete",
    source: "stream_collector",
    message:
      savedCount > 0
        ? `Collector finished with ${savedCount} saved file(s)`
        : "Collector finished with no captured files",
    savedCount,
  });
  return buildSaveResult(savedCount, savedFiles, [...metadataIds], streamEvents);
};

const ensureContext = async () => {
  await ensureConfig();
  if (context) return context;
  if (!contextStarting) {
    contextStarting = (async () => {
      await ensureStorageDir();
      const browserType = browsers[config.browser];
      if (!browserType) {
        throw new Error(
          `Unsupported PW_BROWSER '${config.browser}'. Use chromium, firefox, or webkit.`,
        );
      }
      const args = [...config.extraArgs];
      if (config.humanize && config.disableAutomation) {
        if (!args.includes("--disable-blink-features=AutomationControlled")) {
          args.push("--disable-blink-features=AutomationControlled");
        }
      }
      if (!config.headless && config.startMinimized) {
        if (!args.includes("--start-minimized")) {
          args.push("--start-minimized");
        }
      }
      const proxy = config.proxyServer
        ? { server: config.proxyServer }
        : undefined;
      const launchOptions = {
        headless: config.headless,
        acceptDownloads: config.acceptDownloads,
        viewport: config.viewport ?? undefined,
        userAgent: config.userAgent || undefined,
        locale: config.locale || undefined,
        timezoneId: config.timezoneId || undefined,
        geolocation: config.geolocation ?? undefined,
        permissions: config.permissions.length ? config.permissions : undefined,
        colorScheme: config.colorScheme || undefined,
        deviceScaleFactor: config.deviceScaleFactor || undefined,
        slowMo: config.slowMoMs || undefined,
        args: args.length ? args : undefined,
        executablePath: config.executablePath || undefined,
        proxy,
      };
      if (
        config.headless &&
        config.browser === "chromium" &&
        !config.headlessUseSystem
      ) {
        launchOptions.executablePath = undefined;
        launchOptions.channel = undefined;
      }
      if (
        config.browser === "chromium" &&
        config.channel &&
        (!config.headless || config.headlessUseSystem)
      ) {
        launchOptions.channel = config.channel;
      }
      let ctx;
      try {
        ctx = await browserType.launchPersistentContext(
          config.storageDir,
          launchOptions,
        );
      } catch (error) {
        const canFallback =
          config.browser === "chromium" &&
          (launchOptions.executablePath || launchOptions.channel);
        if (!canFallback) {
          throw error;
        }
        console.warn(
          "Primary Chrome launch failed. Retrying with bundled Chromium...",
          error,
        );
        const fallbackOptions = {
          ...launchOptions,
          executablePath: undefined,
          channel: undefined,
        };
        ctx = await browserType.launchPersistentContext(
          config.storageDir,
          fallbackOptions,
        );
      }
      if (config.humanize) {
        await ctx.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
        });
      }
      scheduleMinimize();
      ctx.on("close", () => {
        context = null;
        page = null;
        minimizeScheduled = false;
      });
      return ctx;
    })();
  }
  context = await contextStarting;
  contextStarting = null;
  return context;
};

const relaunchHeadfulForLogin = async (url) => {
  if (headfulRelaunchUsed || !config.autoHeadfulOnLogin || !config.headless) {
    return false;
  }
  headfulRelaunchUsed = true;
  console.warn("Login/verification needed. Relaunching headful browser...");
  config.headless = false;
  await closeContext();
  const ctx = await ensureContext();
  const newPage = await ctx.newPage();
  await newPage.goto(url, {
    waitUntil: config.waitUntil,
    timeout: config.navTimeoutMs,
  });
  return true;
};

const isLoginLikeUrl = (url) => {
  if (!url) return false;
  return /accounts\.openai\.com|\/auth\b|\/login\b|\/signin\b|sign-in/i.test(
    url,
  );
};

const ensurePage = async () => {
  const ctx = await ensureContext();
  if (page && !page.isClosed()) return page;
  page = await ctx.newPage();
  scheduleMinimize();
  return page;
};

const closePage = async () => {
  if (page && !page.isClosed()) {
    await page.close();
  }
  page = null;
};

const closeContext = async () => {
  await closePage();
  if (context) {
    await context.close();
  }
  context = null;
};

const readJson = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (error) {
    const err = error instanceof Error ? error : new Error("Invalid JSON");
    err.statusCode = 400;
    throw err;
  }
};

const sendJson = (res, statusCode, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const sendError = (res, error) => {
  const statusCode = error?.statusCode ?? 500;
  sendJson(res, statusCode, {
    error: error?.message ?? "Unknown error",
  });
};

const FILE_TYPE_BY_EXTENSION = Object.freeze({
  gif: { ext: ".gif", label: "GIF" },
  pdf: { ext: ".pdf", label: "PDF" },
  doc: { ext: ".doc", label: "DOC" },
  docx: { ext: ".docx", label: "DOCX" },
  csv: { ext: ".csv", label: "CSV" },
  xls: { ext: ".xls", label: "XLS" },
  xlsx: { ext: ".xlsx", label: "XLSX" },
  ppt: { ext: ".ppt", label: "PPT" },
  pptx: { ext: ".pptx", label: "PPTX" },
  txt: { ext: ".txt", label: "TXT" },
  md: { ext: ".md", label: "Markdown" },
  json: { ext: ".json", label: "JSON" },
  zip: { ext: ".zip", label: "ZIP" },
});

const FILE_TYPE_PATTERNS = [
  { type: "gif", pattern: /\b(animated gif|gif)\b/i },
  { type: "pdf", pattern: /\b(pdf|portable document format)\b/i },
  { type: "docx", pattern: /\b(docx|word document|microsoft word|ms word)\b/i },
  { type: "csv", pattern: /\b(csv|comma[- ]separated|tabular data)\b/i },
  { type: "xlsx", pattern: /\b(xlsx|excel workbook|spreadsheet)\b/i },
  { type: "pptx", pattern: /\b(pptx|powerpoint|slide deck|slides)\b/i },
  { type: "txt", pattern: /\b(txt|text file|plain text)\b/i },
  { type: "md", pattern: /\b(markdown|\.md\b)\b/i },
  { type: "json", pattern: /\b(json)\b/i },
  { type: "zip", pattern: /\b(zip|archive)\b/i },
];

const hasImageIntent = (value) => {
  if (!value) return false;
  return (
    /\b(generate|create|make|draw|illustrate|render|design|produce)\b(?:\s+\w+){0,4}\s+\b(image|picture|photo|art|illustration|artwork|graphic|logo)\b/i.test(
      value,
    ) ||
    /\b(image|picture|photo|art|illustration|artwork|graphic|logo|wallpaper|portrait)\b/i.test(
      value,
    )
  );
};

const hasFileIntent = (value) => {
  if (!value) return false;
  return (
    /\b(generate|create|make|write|produce|export|build)\b(?:\s+\w+){0,5}\s+\b(file|document|pdf|docx|csv|spreadsheet|report|presentation|gif)\b/i.test(
      value,
    ) ||
    /\b(file|document|pdf|docx|csv|xlsx|pptx|gif|spreadsheet|report|word|excel)\b/i.test(
      value,
    )
  );
};

const detectRequestedFileType = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const extMatch = /\.([a-z0-9]{2,5})\b/i.exec(text);
  if (extMatch?.[1]) {
    const fromExt = FILE_TYPE_BY_EXTENSION[extMatch[1].toLowerCase()];
    if (fromExt) return fromExt;
  }
  for (const candidate of FILE_TYPE_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return FILE_TYPE_BY_EXTENSION[candidate.type] ?? null;
    }
  }
  return null;
};

const normalizeImagePrompt = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return "Please generate an image of a cat riding a bicycle.";
  }
  if (hasImageIntent(trimmed)) {
    return trimmed;
  }
  return `Generate an image of: ${trimmed}`;
};

const normalizeFilePrompt = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const detectedType = detectRequestedFileType(trimmed);
  const fileDescriptor = detectedType
    ? `${detectedType.label} file`
    : "file";
  if (!trimmed) {
    return "Create a downloadable text file with a short greeting message.";
  }
  if (/\bdownloadable\b/i.test(trimmed)) return trimmed;
  return `Create a downloadable ${fileDescriptor} that satisfies this request: ${trimmed}`;
};

const normalizeGenerationMode = (value) => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "image" || raw === "file" || raw === "auto") {
    return raw;
  }
  return "";
};

const resolveGenerationMode = (body) => {
  const explicit =
    normalizeGenerationMode(body?.mode) ||
    normalizeGenerationMode(body?.generationMode);
  if (explicit === "image" || explicit === "file") {
    return explicit;
  }
  const command = typeof body?.command === "string" ? body.command : "";
  if (/generatefile/i.test(command)) {
    return "file";
  }
  const promptCandidates = [];
  if (typeof body?.prompt === "string") {
    promptCandidates.push(body.prompt);
  }
  if (typeof body?.answerPrompt === "string") {
    promptCandidates.push(body.answerPrompt);
  }
  if (Array.isArray(body?.prompts)) {
    for (const entry of body.prompts) {
      if (typeof entry === "string") {
        promptCandidates.push(entry);
      }
    }
  }
  const sample = promptCandidates.join(" ").trim();
  if (!sample) return "image";
  if (hasImageIntent(sample)) return "image";
  if (hasFileIntent(sample)) return "file";
  return "image";
};

const normalizePromptForMode = (value, generationMode = "image") =>
  generationMode === "file"
    ? normalizeFilePrompt(value)
    : normalizeImagePrompt(value);

const normalizeGenerationBatch = (body, { generationMode = "image" } = {}) => {
  const sourcePrompts = Array.isArray(body?.prompts)
    ? body.prompts
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => normalizePromptForMode(entry, generationMode))
    : [];
  const fallbackPrompt = normalizePromptForMode(body?.prompt, generationMode);
  const countRaw = Number(body?.count);
  const requestedCount = Number.isInteger(countRaw) && countRaw > 0 ? countRaw : 1;
  const count = Math.min(requestedCount, 8);
  if (sourcePrompts.length > 0) {
    return sourcePrompts.slice(0, 8);
  }
  return Array.from({ length: count }, () => fallbackPrompt);
};

const parseCommaList = (value) => {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeUploadInput = (body) => {
  const raw = [];
  if (Array.isArray(body?.files)) {
    raw.push(...body.files);
  } else if (typeof body?.files === "string") {
    raw.push(...parseCommaList(body.files));
  }
  if (Array.isArray(body?.filePaths)) {
    raw.push(...body.filePaths);
  } else if (typeof body?.filePaths === "string") {
    raw.push(...parseCommaList(body.filePaths));
  }
  if (typeof body?.file === "string") {
    raw.push(...parseCommaList(body.file));
  }

  const flattened = raw
    .flatMap((entry) => (typeof entry === "string" ? parseCommaList(entry) : []))
    .filter(Boolean);
  return [...new Set(flattened)];
};

const resolveUploadFiles = async (body) => {
  const values = normalizeUploadInput(body);
  if (values.length === 0) return [];

  const resolved = [];
  const invalid = [];
  for (const entry of values) {
    const filePath = resolve(process.cwd(), entry);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        invalid.push(entry);
        continue;
      }
      resolved.push(filePath);
    } catch {
      invalid.push(entry);
    }
  }

  if (invalid.length > 0) {
    const error = new Error(`Upload file(s) not found: ${invalid.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  return resolved;
};

const isChatGptTargetUrl = (value) =>
  /chatgpt\.com|chat\.openai\.com/i.test(value || "");

const normalizeWhitespace = (value) =>
  (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();

const detectAssistantNeedsInput = (text) => {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return false;
  if (
    /\b(upload|attach|send)\b.{0,40}\b(file|files|image|images|photo|photos|selfie|picture)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/\bplease upload\b/i.test(normalized)) return true;
  return normalized.includes("?");
};

const detectAssistantErrorMessage = (text) => {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return null;
  if (
    /\bwe experienced an error when generating (images|files)\b/i.test(
      normalized,
    )
  ) {
    return normalized;
  }
  if (
    /\b(error|failed|failure|unable|couldn['’]t|could not|something went wrong)\b/i.test(
      normalized,
    ) &&
    /\b(image|images|file|files|generation|generate|render|create)\b/i.test(
      normalized,
    )
  ) {
    return normalized;
  }
  return null;
};

const extractLatestAssistantTurn = async (pageInstance) => {
  const turns = pageInstance.locator('article[data-turn="assistant"]');
  const count = await turns.count();
  if (!count) return null;
  const lastTurn = turns.nth(count - 1);
  const turnId = (await lastTurn.getAttribute("data-turn-id")) || null;
  const markdown = lastTurn.locator(".markdown").first();
  let text = "";
  if (await markdown.count()) {
    text = normalizeWhitespace(await markdown.innerText());
  }
  if (!text) {
    text = normalizeWhitespace(await lastTurn.innerText());
  }
  if (!text) return null;
  const clipped = text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
  const errorMessage = detectAssistantErrorMessage(clipped);
  return {
    turnId,
    text: clipped,
    requiresInput: detectAssistantNeedsInput(clipped),
    hasError: Boolean(errorMessage),
    errorMessage,
  };
};

const buildContinuationPrompt = (
  previousContext,
  answerPrompt,
  generationMode = "image",
) => {
  const normalizedAnswer = normalizePromptForMode(
    answerPrompt,
    generationMode,
  );
  const seed = {
    id: previousContext?.id ?? null,
    question: previousContext?.question ?? "",
    result: previousContext?.result ?? null,
  };
  const seedJson = JSON.stringify(seed, null, 2);
  return [
    "Use this context JSON for continuity:",
    seedJson,
    "",
    "Follow-up prompt:",
    normalizedAnswer,
  ].join("\n");
};

const uploadFilesToChatGptComposer = async (activePage, files) => {
  if (!Array.isArray(files) || files.length === 0) return;

  const selectors = [
    'input[type="file"][multiple]',
    'input[type="file"]',
  ];

  for (const selector of selectors) {
    const input = activePage.locator(selector).first();
    if (await input.count()) {
      await input.setInputFiles(files);
      await sleep(500);
      return;
    }
  }

  const attachButton = activePage.getByRole("button", {
    name: /attach|upload|add files|add photos|plus/i,
  });
  if (await attachButton.count()) {
    await attachButton.first().click();
    for (const selector of selectors) {
      const input = activePage.locator(selector).first();
      if (await input.count()) {
        await input.setInputFiles(files);
        await sleep(500);
        return;
      }
    }
  }

  throw new Error("Unable to find a file upload input on the page.");
};

const runChatGptPromptFlow = async (
  activePage,
  {
    prompt,
    effectiveUrl,
    imageRun,
    generationMode = "image",
    streamMode = false,
    uploadFiles = [],
    onActivity = () => undefined,
  },
) => {
  const pageContext = activePage.context();
  const runOwnedPages = new Set();
  const onContextPage = (candidatePage) => {
    Promise.resolve(candidatePage.opener?.())
      .then((opener) => {
        if (opener === activePage) {
          runOwnedPages.add(candidatePage);
        }
      })
      .catch(() => undefined);
  };
  pageContext.on("page", onContextPage);

  let shouldClosePage = false;
  let result = buildSaveResult();
  let assistantErrorMessageSeen = null;
  let assistantTurnIdSeen = null;
  let assistantTurnTextSeen = "";
  let assistantPollTimer = null;
  let assistantProbeQueue = Promise.resolve();
  const emitActivity = (activity) => {
    Promise.resolve(onActivity(activity)).catch(() => undefined);
  };
  const probeAssistantTurn = async (important = false) => {
    assistantProbeQueue = assistantProbeQueue
      .catch(() => undefined)
      .then(async () => {
        const turn = await extractLatestAssistantTurn(activePage);
        if (!turn) return;
        if (
          turn.turnId === assistantTurnIdSeen &&
          turn.text === assistantTurnTextSeen
        ) {
          return;
        }
        assistantTurnIdSeen = turn.turnId;
        assistantTurnTextSeen = turn.text;
        if (turn.hasError && turn.errorMessage) {
          assistantErrorMessageSeen = turn.errorMessage;
          console.error("Assistant error:", turn.errorMessage);
        } else {
          console.log("Assistant turn:", turn.text);
        }
        emitActivity({
          type: turn.hasError
            ? "assistant_error"
            : turn.requiresInput
              ? "assistant_question"
              : "assistant_message",
          assistantTurnId: turn.turnId,
          message: turn.text,
          errorMessage: turn.errorMessage || null,
          requiresInput: turn.requiresInput || turn.hasError,
          important: important || turn.requiresInput || turn.hasError,
        });
      });
    await assistantProbeQueue;
  };
  const mergeResult = (next) => {
    result = mergeSaveResults(result, next);
    if (next?.metadataIds?.length) {
      const metadataId = next.metadataIds[next.metadataIds.length - 1];
      emitActivity({
        type: "metadata_detected",
        metadataId,
        important: true,
      });
    }
    if (next?.savedFiles?.length) {
      const latest = next.savedFiles[next.savedFiles.length - 1];
      emitActivity({
        type: generationMode === "file" ? "file_saved" : "image_saved",
        outputPath: latest?.filePath ?? null,
        important: true,
      });
    }
    emitActivity({
      type: "progress",
      savedCount: result.savedCount ?? 0,
    });
  };
  const isRunPage = (candidatePage) =>
    Boolean(candidatePage) &&
    (candidatePage === activePage || runOwnedPages.has(candidatePage));
  const collectDownloads = async () =>
    collectChatGptDownloads(activePage, {
      timeoutMs: config.imageTimeoutMs,
      idleMs: config.imageIdleMs,
      maxFiles: config.imageMax,
      imageRun,
      onStreamEvent: (streamEvent) => {
        emitActivity({
          type: "stream_event",
          streamEvent,
          metadataId:
            typeof streamEvent?.metadataId === "string" &&
            streamEvent.metadataId
              ? streamEvent.metadataId
              : undefined,
          outputPath:
            typeof streamEvent?.outputPath === "string" &&
            streamEvent.outputPath
              ? streamEvent.outputPath
              : undefined,
          message:
            typeof streamEvent?.message === "string" && streamEvent.message
              ? streamEvent.message
              : `Stream event: ${streamEvent?.type || "activity"}`,
          important:
            streamEvent?.type === "file_saved" ||
            streamEvent?.type === "save_failed",
        });
      },
    });

  try {
    emitActivity({ type: "flow_start", message: "Loading composer" });
    console.log("Page loaded, typing message...");
    await activePage.waitForLoadState("domcontentloaded", {
      timeout: 60_000,
    });
    try {
      await activePage.waitForLoadState("networkidle", {
        timeout: 10_000,
      });
    } catch {
      // ignore network idle timeouts; ChatGPT keeps connections open
    }
    if (activePage.isClosed()) {
      throw new Error("Page closed before composer was ready.");
    }
    emitActivity({ type: "composer_ready", message: "Composer ready" });
    const urlNow = activePage.url();
    if (isLoginLikeUrl(urlNow)) {
      const relaunched = await relaunchHeadfulForLogin(urlNow);
      if (relaunched) {
        return {
          status: "relaunch",
          message:
            "Login detected and browser was relaunched in headful mode to complete auth.",
          ...result,
        };
      }
      throw new Error(
        "Login page detected. Sign in once (headful) to establish session cookies.",
      );
    }
    if (urlNow.includes("__cf_chl_")) {
      const relaunched = await relaunchHeadfulForLogin(effectiveUrl);
      if (relaunched) {
        return {
          status: "relaunch",
          message:
            "Cloudflare challenge detected and browser was relaunched in headful mode.",
          ...result,
        };
      }
      throw new Error(
        "Cloudflare challenge still active. Complete the challenge in headful mode first.",
      );
    }
    const loginButton = await activePage
      .getByRole("button", { name: /log in|sign in|continue/i })
      .count();
    const loginLink = await activePage
      .getByRole("link", { name: /log in|sign in/i })
      .count();
    if (loginButton || loginLink) {
      const relaunched = await relaunchHeadfulForLogin(effectiveUrl);
      if (relaunched) {
        return {
          status: "relaunch",
          message:
            "Login screen detected and browser was relaunched in headful mode.",
          ...result,
        };
      }
      throw new Error(
        "Login screen detected. Sign in once (headful) to establish session cookies.",
      );
    }

    if (uploadFiles.length > 0) {
      await uploadFilesToChatGptComposer(activePage, uploadFiles);
      emitActivity({
        type: "files_uploaded",
        message: `Uploaded ${uploadFiles.length} file(s)`,
      });
    }

    const submitPromptAndCollect = async (attemptNumber) => {
      const savedCountBefore = result.savedCount ?? 0;
      try {
        await activePage.keyboard.insertText(prompt);
      } catch {
        await activePage.keyboard.type(prompt);
      }
      const submit = activePage.locator(
        '#composer-submit-button, button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Send message"]',
      );
      if (await submit.count()) {
        await submit.first().click();
      } else {
        await activePage.keyboard.press("Enter");
      }
      emitActivity({
        type: "prompt_submitted",
        message:
          attemptNumber > 1
            ? `Prompt submitted (retry ${attemptNumber - 1})`
            : "Prompt submitted",
        important: true,
      });
      if (!assistantPollTimer) {
        assistantPollTimer = setInterval(() => {
          probeAssistantTurn(false).catch(() => undefined);
        }, 1_500);
      }

      if (streamMode) {
        emitActivity({
          type: "stream_capture_start",
          message: "Stream capture enabled",
          important: true,
        });
        mergeResult(await collectDownloads());
        if ((result.savedCount ?? 0) > savedCountBefore) {
          return;
        }
        console.warn(
          "Stream capture enabled, but no streamed files were captured. Falling back to async-status/download flow.",
        );
      }

      let responseQueue = Promise.resolve();
      let lastDownload = {
        url: null,
        downloadUrl: null,
        fileName: null,
        contentType: null,
        buffer: null,
        metadataId: null,
        conversationId: null,
        ts: 0,
      };
      let lastValidDownload = null;
      let lastAfterAsync = null;
      let asyncSeenAt = 0;
      let asyncConversationId = null;
      const isAfterAsync = (record) => {
        if (!asyncSeenAt) return false;
        if (record.ts < asyncSeenAt) return false;
        if (!asyncConversationId) return true;
        if (!record.conversationId) return true;
        return record.conversationId === asyncConversationId;
      };
      let assistantFallbackAttempted = false;

      const responseListener = (response) => {
        responseQueue = responseQueue
          .catch(() => undefined)
          .then(async () => {
            const responseUrl = new URL(response.url());
            if (responseUrl.hostname !== "chatgpt.com") return;
            if (
              !responseUrl.pathname.startsWith("/backend-api/files/download/")
            ) {
              return;
            }
            const conversationId = extractConversationId(response.url());
            const responseMetadataId = extractFileId(response.url());
            let record = {
              url: response.url(),
              downloadUrl: null,
              fileName: null,
              contentType: null,
              buffer: null,
              metadataId: responseMetadataId,
              conversationId,
              ts: Date.now(),
            };
            lastDownload = record;
            console.log("Last download candidate:", lastDownload.url);
            if (record.metadataId) {
              emitActivity({
                type: "download_candidate",
                metadataId: record.metadataId,
              });
            }
            const contentType = response.headers()["content-type"] ?? "";
            if (isJsonContentType(contentType)) {
              try {
                const fileInfo = await response.json();
                console.log("Received file download metadata:", fileInfo);
                if (fileInfo?.detail?.message) {
                  console.warn(
                    "Download metadata error:",
                    fileInfo.detail.message,
                  );
                  return;
                }
                if (typeof fileInfo?.download_url === "string") {
                  record = {
                    ...record,
                    downloadUrl: fileInfo.download_url,
                    metadataId:
                      extractFileId(fileInfo.download_url) || record.metadataId,
                  };
                }
                if (typeof fileInfo?.file_name === "string") {
                  record = {
                    ...record,
                    fileName: basename(fileInfo.file_name),
                  };
                }
                lastDownload = record;
                if (record.downloadUrl) {
                  lastValidDownload = record;
                }
                if (isAfterAsync(record)) {
                  lastAfterAsync = record;
                }
                if (record.metadataId) {
                  emitActivity({
                    type: "metadata_detected",
                    metadataId: record.metadataId,
                    message: "Metadata update received",
                    important: true,
                  });
                }
              } catch (error) {
                console.warn("Failed to parse download metadata:", error);
              }
              return;
            }
            if (!isJsonContentType(contentType)) {
              const contentDisposition =
                response.headers()["content-disposition"] ?? "";
              const fileNameHint = parseContentDispositionFileName(
                contentDisposition,
              );
              record = {
                ...record,
                downloadUrl: response.url(),
                contentType,
                fileName: fileNameHint
                  ? basename(fileNameHint)
                  : `${imageRun?.filePrefix || "download"}-${Date.now()}`,
              };
              lastDownload = record;
              lastValidDownload = record;
              if (isAfterAsync(record)) {
                lastAfterAsync = record;
              }
            }
          });
      };

      activePage.on("response", responseListener);

      try {
        await activePage.waitForRequest(
          (request) => {
            if (request.method() !== "POST") return false;
            const requestUrl = new URL(request.url());
            if (requestUrl.hostname !== "chatgpt.com") return false;
            if (
              !requestUrl.pathname.startsWith("/backend-api/conversation/")
            ) {
              return false;
            }
            if (!requestUrl.pathname.endsWith("/async-status")) {
              return false;
            }
            asyncConversationId = extractConversationId(request.url());
            asyncSeenAt = Date.now();
            return true;
          },
          { timeout: config.imageTimeoutMs },
        );

        if (asyncConversationId) {
          console.log("Async-status conversation:", asyncConversationId);
          emitActivity({
            type: "async_status_detected",
            message: `Async status for conversation ${asyncConversationId}`,
            important: true,
          });
        }

        const waitForAfterAsync = async () => {
          const deadline = Date.now() + config.asyncPostWindowMs;
          while (!lastAfterAsync && Date.now() < deadline) {
            await responseQueue;
            await sleep(100);
          }
        };

        await waitForAfterAsync();
        activePage.off("response", responseListener);

        if (lastAfterAsync) {
          console.log(
            "Async-status detected. Last file after async:",
            lastAfterAsync.downloadUrl ?? lastAfterAsync.url,
          );
          mergeResult(
            await saveDownloadRecord(activePage, lastAfterAsync, { imageRun }),
          );
        } else {
          const fallbackAfterAsync =
            (lastValidDownload && lastValidDownload.ts >= asyncSeenAt
              ? lastValidDownload
              : null) ||
            (lastDownload && lastDownload.ts >= asyncSeenAt ? lastDownload : null);
          if (fallbackAfterAsync) {
            console.warn(
              "No conversation-matched download after async-status. Using latest post-async download candidate.",
            );
            mergeResult(
              await saveDownloadRecord(activePage, fallbackAfterAsync, { imageRun }),
            );
          } else {
            console.warn(
              "Async-status detected, but no post-async download found. Falling back to collector.",
            );
            mergeResult(await collectDownloads());
          }
        }
        if ((result.savedCount ?? 0) === savedCountBefore) {
          console.warn(
            "Async-status flow did not save any files. Falling back to collector.",
          );
          mergeResult(await collectDownloads());
        }
      } catch (error) {
        activePage.off("response", responseListener);
        console.warn(
          "Async-status wait failed. Trying assistant download controls before collector.",
        );
        assistantFallbackAttempted = true;
        mergeResult(
          await collectAssistantDownloadsAfterCompletion(activePage, {
            imageRun,
            timeoutMs: Math.max(12_000, config.imageIdleMs + 10_000),
            isPageAllowed: isRunPage,
          }),
        );
        if ((result.savedCount ?? 0) === savedCountBefore) {
          console.warn(
            "Assistant download fallback found no files. Falling back to collector.",
          );
          mergeResult(await collectDownloads());
        }
      }
      if (
        !assistantFallbackAttempted &&
        (result.savedCount ?? 0) === savedCountBefore
      ) {
        console.warn(
          "No direct download stream found. Looking for assistant download links.",
        );
        mergeResult(
          await collectAssistantDownloadsAfterCompletion(activePage, {
            imageRun,
            timeoutMs: Math.max(12_000, config.imageIdleMs + 10_000),
            isPageAllowed: isRunPage,
          }),
        );
      }
    };

    await submitPromptAndCollect(1);
    if ((result.savedCount ?? 0) === 0 && assistantErrorMessageSeen) {
      emitActivity({
        type: "flow_retry",
        message: "Assistant reported generation error. Retrying once.",
        errorMessage: assistantErrorMessageSeen,
        important: true,
      });
      console.warn("Assistant reported generation error. Retrying once...");
      assistantErrorMessageSeen = null;
      await submitPromptAndCollect(2);
    }

    console.log(
      `Saved ${result.savedCount} ${
        generationMode === "file" ? "file(s)" : "image(s)"
      }.`,
    );
    if ((result.savedCount ?? 0) === 0 && assistantErrorMessageSeen) {
      emitActivity({
        type: "flow_error",
        message: assistantErrorMessageSeen,
        important: true,
      });
      await probeAssistantTurn(true);
      return {
        status: "error",
        error: assistantErrorMessageSeen,
        ...result,
      };
    }
    if ((result.savedCount ?? 0) > 0) {
      shouldClosePage = true;
    }
    emitActivity({
      type: "flow_completed",
      savedCount: result.savedCount ?? 0,
      important: true,
    });
    await probeAssistantTurn(true);
    return {
      status: "completed",
      ...result,
    };
  } catch (error) {
    console.error("ChatGPT flow error:", error);
    emitActivity({
      type: "flow_error",
      message: error?.message ?? String(error),
      important: true,
    });
    await probeAssistantTurn(true);
    return {
      status: "error",
      error: error?.message ?? String(error),
      ...result,
    };
  } finally {
    pageContext.off("page", onContextPage);
    if (assistantPollTimer) {
      clearInterval(assistantPollTimer);
      assistantPollTimer = null;
    }
    if (shouldClosePage) {
      for (const candidatePage of runOwnedPages) {
        if (!candidatePage || candidatePage === activePage) continue;
        if (candidatePage.isClosed()) continue;
        try {
          await candidatePage.close();
        } catch {
          // best effort cleanup of download popups/tabs
        }
      }
      if (!activePage.isClosed()) {
        await activePage.close();
      }
      if (page === activePage) {
        page = null;
      }
    }
  }
};

const runOpenPromptRequest = async (
  ctx,
  {
    effectiveUrl,
    prompt,
    syncMode,
    imageRun,
    generationMode = "image",
    streamMode = false,
    useSharedPage,
    uploadFiles = [],
    contextSeed = null,
  },
) => {
  const activePage = useSharedPage ? await ensurePage() : await ctx.newPage();
  const getPageUrl = () => {
    try {
      return activePage.url();
    } catch {
      return effectiveUrl;
    }
  };
  await activePage.goto(effectiveUrl, {
    waitUntil: config.waitUntil,
    timeout: config.navTimeoutMs,
  });
  console.log(`Navigated to URL: ${activePage.url()}`);

  const plannedFilePrefix = imageRun.randomizeFileNames
    ? `${imageRun.filePrefix || "image"}-${imageRun.runId}-`
    : null;
  const contextId =
    sanitizeContextId(contextSeed?.id) || randomUUID();
  const contextFile = contextRunPath(contextId);
  let contextRecord = {
    id: contextId,
    parentContextId: sanitizeContextId(contextSeed?.parentContextId) || null,
    sourceContextId: sanitizeContextId(contextSeed?.sourceContextId) || null,
    status: "queued",
    sync: syncMode,
    stream: streamMode,
    generationMode,
    question: prompt,
    context: { question: prompt },
    effectiveUrl,
    outputDir: config.outputDir,
    uploadFiles,
    observedMetadataIds: [],
    observedOutputFiles: [],
    streamEvents: [],
    keepAlive: {
      state: "queued",
      heartbeatSeq: 0,
      lastHeartbeatAt: null,
      lastActivityAt: null,
      lastActivityType: "queued",
      lastMessage: "Queued",
      lastMetadataId: null,
      lastOutputPath: null,
      lastErrorMessage: null,
      waitingForUserInput: false,
      lastAssistantMessage: null,
      lastAssistantTurnId: null,
    },
    events: [],
    assistantQuestion: null,
    assistantError: null,
  };

  const persistRunContext = async (patch) => {
    const next = { ...contextRecord, ...(patch ?? {}) };
    const persisted = await persistContextRun(next);
    if (persisted?.payload) {
      contextRecord = persisted.payload;
    } else {
      contextRecord = next;
    }
    return contextRecord;
  };

  await persistRunContext();

  let heartbeatTimer = null;
  let lastActivityWriteMs = 0;

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const noteActivity = async (activity = {}) => {
    const nowMs = Date.now();
    const important = activity.important === true;
    if (!important && nowMs - lastActivityWriteMs < 1_200) {
      return;
    }
    lastActivityWriteMs = nowMs;
    const nowIso = new Date(nowMs).toISOString();
    const prevKeepAlive = contextRecord.keepAlive ?? {};
    const currentMetadata = contextRecord.observedMetadataIds ?? [];
    const currentOutputFiles = contextRecord.observedOutputFiles ?? [];
    const currentStreamEvents = contextRecord.streamEvents ?? [];
    const metadataId =
      typeof activity.metadataId === "string" && activity.metadataId
        ? activity.metadataId
        : null;
    const outputPath =
      typeof activity.outputPath === "string" && activity.outputPath
        ? activity.outputPath
        : null;
    const streamEvent =
      activity.streamEvent &&
      typeof activity.streamEvent === "object" &&
      !Array.isArray(activity.streamEvent)
        ? {
            ...activity.streamEvent,
            ts:
              typeof activity.streamEvent.ts === "string" &&
              activity.streamEvent.ts
                ? activity.streamEvent.ts
                : nowIso,
          }
        : null;
    const nextMetadata = metadataId
      ? [...new Set([...currentMetadata, metadataId])]
      : currentMetadata;
    const nextOutputFiles = outputPath
      ? [...new Set([...currentOutputFiles, outputPath])]
      : currentOutputFiles;
    const nextStreamEvents = streamEvent
      ? [...currentStreamEvents, streamEvent].slice(-200)
      : currentStreamEvents;
    const nextHeartbeatSeq =
      activity.type === "heartbeat"
        ? (prevKeepAlive.heartbeatSeq ?? 0) + 1
        : prevKeepAlive.heartbeatSeq ?? 0;
    const message =
      typeof activity.message === "string" && activity.message
        ? activity.message
        : prevKeepAlive.lastMessage ?? null;
    const assistantTurnId =
      typeof activity.assistantTurnId === "string" && activity.assistantTurnId
        ? activity.assistantTurnId
        : null;
    const requiresInput = activity.requiresInput === true;
    const isAssistantError = activity.type === "assistant_error";
    const errorMessage =
      typeof activity.errorMessage === "string" && activity.errorMessage
        ? activity.errorMessage
        : isAssistantError
          ? message || null
          : null;
    const waitingForUserInput =
      activity.type === "flow_completed" || activity.type === "flow_error"
        ? false
        : requiresInput || isAssistantError
          ? true
          : prevKeepAlive.waitingForUserInput ?? false;
    const lastAssistantMessage =
      activity.type === "assistant_question" || activity.type === "assistant_message"
        ? message
        : prevKeepAlive.lastAssistantMessage ?? null;
    const lastAssistantTurnId =
      assistantTurnId || prevKeepAlive.lastAssistantTurnId || null;

    const event = {
      ts: nowIso,
      type: activity.type || "activity",
      message: message || null,
      metadataId,
      outputPath,
      assistantTurnId,
      requiresInput: requiresInput || null,
      errorMessage,
      savedCount:
        Number.isFinite(activity.savedCount) ? activity.savedCount : null,
      streamEventType:
        streamEvent && typeof streamEvent.type === "string"
          ? streamEvent.type
          : null,
    };
    const events = [...(contextRecord.events ?? []), event].slice(-80);

    await persistRunContext({
      status:
        contextRecord.status === "queued"
          ? "running"
          : contextRecord.status === "completed" || contextRecord.status === "error"
            ? contextRecord.status
            : "running",
      observedMetadataIds: nextMetadata,
      observedOutputFiles: nextOutputFiles,
      streamEvents: nextStreamEvents,
      keepAlive: {
        state:
          contextRecord.status === "completed" || contextRecord.status === "error"
            ? contextRecord.status
            : "running",
        heartbeatSeq: nextHeartbeatSeq,
        lastHeartbeatAt:
          activity.type === "heartbeat" ? nowIso : prevKeepAlive.lastHeartbeatAt,
        lastActivityAt: nowIso,
        lastActivityType: activity.type || prevKeepAlive.lastActivityType,
        lastMessage: message,
        lastMetadataId: metadataId ?? prevKeepAlive.lastMetadataId ?? null,
        lastOutputPath: outputPath ?? prevKeepAlive.lastOutputPath ?? null,
        lastErrorMessage: errorMessage ?? prevKeepAlive.lastErrorMessage ?? null,
        waitingForUserInput,
        lastAssistantMessage,
        lastAssistantTurnId,
      },
      events,
      assistantQuestion: requiresInput
        ? {
            turnId: assistantTurnId,
            text: message || "",
            askedAt: nowIso,
          }
        : contextRecord.assistantQuestion ?? null,
      assistantError: isAssistantError
        ? {
            turnId: assistantTurnId,
            text: message || "",
            errorMessage: errorMessage || message || "",
            detectedAt: nowIso,
          }
        : contextRecord.assistantError ?? null,
    });
  };

  await noteActivity({
    type: "started",
    message: "Run started",
    important: true,
  });
  heartbeatTimer = setInterval(() => {
    noteActivity({
      type: "heartbeat",
      message: "Waiting for generation updates",
    }).catch(() => undefined);
  }, 3_000);

  if (!isChatGptTargetUrl(effectiveUrl)) {
    const pageUrl = getPageUrl();
    if (!useSharedPage && !activePage.isClosed()) {
      await activePage.close();
    }
    stopHeartbeat();
    await persistRunContext({
      status: "completed",
      completedAt: new Date().toISOString(),
      pageUrl,
      result: {
        status: "ok",
        savedCount: 0,
        savedFiles: [],
        metadataIds: [],
      },
      keepAlive: {
        ...(contextRecord.keepAlive ?? {}),
        state: "completed",
        lastActivityAt: new Date().toISOString(),
        lastActivityType: "completed",
        lastMessage: "Completed without ChatGPT target",
        lastErrorMessage: null,
        waitingForUserInput: false,
      },
    });
    return {
      status: "ok",
      pageUrl,
      sync: syncMode,
      stream: streamMode,
      queued: false,
      runId: imageRun.runId,
      generationMode,
      randomizedFileNames: imageRun.randomizeFileNames,
      plannedFilePrefix,
      savedCount: 0,
      savedFiles: [],
      metadataIds: [],
      contextId,
      contextFile,
      keepAlive: contextRecord.keepAlive,
      context: syncMode ? contextRecord : undefined,
    };
  }

  console.log(`Auto-started URL: ${effectiveUrl}`);
  const flowPromise = runChatGptPromptFlow(activePage, {
    prompt,
    effectiveUrl,
    imageRun,
    generationMode,
    streamMode,
    uploadFiles,
    onActivity: noteActivity,
  });
  if (syncMode) {
    const flowResult = await flowPromise;
    stopHeartbeat();
    const pageUrl = getPageUrl();
    await persistRunContext({
      status: flowResult.status === "error" ? "error" : "completed",
      completedAt: new Date().toISOString(),
      pageUrl,
      result: flowResult,
      keepAlive: {
        ...(contextRecord.keepAlive ?? {}),
        state: flowResult.status === "error" ? "error" : "completed",
        lastActivityAt: new Date().toISOString(),
        lastActivityType:
          flowResult.status === "error" ? "flow_error" : "flow_completed",
        lastMessage:
          flowResult.status === "error"
            ? flowResult.error || "Flow failed"
            : "Flow completed",
        lastErrorMessage:
          flowResult.status === "error"
            ? flowResult.error || "Flow failed"
            : contextRecord.keepAlive?.lastErrorMessage ?? null,
        waitingForUserInput: false,
      },
    });
    return {
      status: flowResult.status === "error" ? "error" : "ok",
      pageUrl,
      sync: true,
      stream: streamMode,
      queued: false,
      runId: imageRun.runId,
      generationMode,
      randomizedFileNames: imageRun.randomizeFileNames,
      plannedFilePrefix,
      contextId,
      contextFile,
      keepAlive: contextRecord.keepAlive,
      context: contextRecord,
      ...flowResult,
    };
  }
  flowPromise
    .then(async (flowResult) => {
      stopHeartbeat();
      await persistRunContext({
        status: flowResult.status === "error" ? "error" : "completed",
        completedAt: new Date().toISOString(),
        pageUrl: getPageUrl(),
        result: flowResult,
        keepAlive: {
          ...(contextRecord.keepAlive ?? {}),
          state: flowResult.status === "error" ? "error" : "completed",
          lastActivityAt: new Date().toISOString(),
          lastActivityType:
            flowResult.status === "error" ? "flow_error" : "flow_completed",
          lastMessage:
            flowResult.status === "error"
              ? flowResult.error || "Flow failed"
              : "Flow completed",
          lastErrorMessage:
            flowResult.status === "error"
              ? flowResult.error || "Flow failed"
              : contextRecord.keepAlive?.lastErrorMessage ?? null,
          waitingForUserInput: false,
        },
      });
    })
    .catch(async (error) => {
      stopHeartbeat();
      console.error("ChatGPT flow error:", error);
      await persistRunContext({
        status: "error",
        completedAt: new Date().toISOString(),
        pageUrl: getPageUrl(),
        error: error?.message ?? String(error),
        keepAlive: {
          ...(contextRecord.keepAlive ?? {}),
          state: "error",
          lastActivityAt: new Date().toISOString(),
          lastActivityType: "flow_error",
          lastMessage: error?.message ?? String(error),
          lastErrorMessage: error?.message ?? String(error),
          waitingForUserInput: false,
        },
      });
    });
  return {
    status: "ok",
    pageUrl: getPageUrl(),
    sync: false,
    stream: streamMode,
    queued: true,
    runId: imageRun.runId,
    generationMode,
    randomizedFileNames: imageRun.randomizeFileNames,
    plannedFilePrefix,
    contextId,
    contextFile,
    keepAlive: contextRecord.keepAlive,
  };
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/health") {
      const pages = context
        ? context.pages().map((tab, index) => ({ index, url: tab.url() }))
        : [];
      return sendJson(res, 200, {
        status: "ok",
        browser: config.browser,
        headless: config.headless,
        acceptDownloads: config.acceptDownloads,
        humanize: config.humanize,
        channel: config.channel || null,
        executablePath: config.executablePath || null,
        storageDir: config.storageDir,
        outputDir: config.outputDir,
        context: context ? "open" : "closed",
        pages,
      });
    }

    if (req.method === "GET" && url.pathname === "/context") {
      const id =
        sanitizeContextId(url.searchParams.get("id")) ||
        sanitizeContextId(url.searchParams.get("contextId"));
      if (!id) {
        const error = new Error("id query parameter is required");
        error.statusCode = 400;
        throw error;
      }
      const record = await loadContextRun(id);
      if (!record) {
        const error = new Error(`Context not found for id '${id}'`);
        error.statusCode = 404;
        throw error;
      }
      return sendJson(res, 200, {
        status: "ok",
        context: record,
      });
    }

    if (req.method === "POST" && url.pathname === "/open") {
      const body = await readJson(req);
      const targetUrl = typeof body?.url === "string" ? body.url : "";
      const reusePage = body?.reusePage === true;
      const sourceContextId =
        sanitizeContextId(body?.contextId) || sanitizeContextId(body?.id);
      const answerPromptInput =
        typeof body?.answerPrompt === "string" ? body.answerPrompt.trim() : "";
      let sourceContext = null;
      if (sourceContextId) {
        sourceContext = await loadContextRun(sourceContextId);
        if (!sourceContext) {
          const error = new Error(`Context not found for id '${sourceContextId}'`);
          error.statusCode = 404;
          throw error;
        }
      }
      const projectUrlInput =
        typeof body?.projectUrl === "string"
          ? body.projectUrl
          : typeof body?.projectId === "string"
            ? body.projectId
            : "";
      const projectUrlOverride = buildChatGptProjectUrl(projectUrlInput);
      const rememberProject =
        body?.rememberProject === true || body?.setGlobalProject === true;
      const outputDirInput =
        typeof body?.dir === "string" ? body.dir.trim() : "";
      if (projectUrlOverride) {
        config.chatGptProjectUrl = projectUrlOverride;
        config.chatGptProjectId = "";
        if (rememberProject) {
          await persistLocalConfig();
        }
      }
      const generationMode = resolveGenerationMode(body);
      let prompts = normalizeGenerationBatch(body, { generationMode });
      if (sourceContext) {
        const followupPromptInput =
          answerPromptInput ||
          (typeof body?.prompt === "string" ? body.prompt.trim() : "");
        if (!followupPromptInput) {
          const error = new Error(
            "answerPrompt (or prompt) is required when contextId is provided",
          );
          error.statusCode = 400;
          throw error;
        }
        prompts = [
          buildContinuationPrompt(
            sourceContext,
            followupPromptInput,
            generationMode,
          ),
        ];
      }
      const uploadFiles = await resolveUploadFiles(body);
      const syncMode = body?.sync === true || body?.wait === true;
      const streamMode =
        body?.stream === true || body?.streamImages === true;
      const randomizeFileNames =
        body?.randomName === true || body?.randomizeFileName === true;
      const multiPrompt = prompts.length > 1;

      const ctx = await ensureContext();
      if (outputDirInput) {
        await setOutputDir(outputDirInput);
      }
      const chatGptProjectUrl =
        projectUrlOverride || config.chatGptProjectUrl;
      const trimmedTarget = targetUrl.trim();
      const isChatGptBase =
        !trimmedTarget ||
        /^https?:\/\/(chatgpt\.com|chat\.openai\.com)\/?$/i.test(trimmedTarget);
      const effectiveUrl =
        isChatGptBase && chatGptProjectUrl
          ? chatGptProjectUrl
          : trimmedTarget || config.startUrl;
      if (effectiveUrl) {
        const runs = await Promise.all(
          prompts.map((prompt, index) =>
            runOpenPromptRequest(ctx, {
              effectiveUrl,
              prompt,
              syncMode,
              streamMode,
              imageRun: createImageRun({ randomizeFileNames, generationMode }),
              generationMode,
              useSharedPage: !multiPrompt && reusePage && index === 0,
              uploadFiles,
              contextSeed: {
                id: randomUUID(),
                parentContextId: sourceContext?.id ?? null,
                sourceContextId: sourceContext?.id ?? null,
              },
            }),
          ),
        );
        if (runs.length === 1) {
          return sendJson(res, 200, {
            ...runs[0],
            pages: ctx.pages().length,
            outputDir: config.outputDir,
            promptCount: prompts.length,
            uploadCount: uploadFiles.length,
            sourceContextId: sourceContext?.id ?? null,
            generationMode,
            stream: streamMode,
          });
        }
        return sendJson(res, 200, {
          status: runs.some((run) => run.status === "error") ? "error" : "ok",
          sync: syncMode,
          stream: streamMode,
          queued: !syncMode,
          promptCount: prompts.length,
          uploadCount: uploadFiles.length,
          sourceContextId: sourceContext?.id ?? null,
          generationMode,
          runs,
          pages: ctx.pages().length,
          outputDir: config.outputDir,
        });
      }
      const activePage = await ensurePage();
      return sendJson(res, 200, {
        status: "ok",
        pageUrl: activePage.url(),
        pages: ctx.pages().length,
        outputDir: config.outputDir,
        generationMode,
        stream: streamMode,
      });
    }

    if (req.method === "POST" && url.pathname === "/goto") {
      const body = await readJson(req);
      const targetUrl = typeof body?.url === "string" ? body.url : "";
      if (!targetUrl) {
        return sendJson(res, 400, { error: "url is required" });
      }
      const activePage = await ensurePage();
      await activePage.goto(targetUrl, {
        waitUntil: config.waitUntil,
        timeout: config.navTimeoutMs,
      });
      return sendJson(res, 200, { status: "ok", pageUrl: activePage.url() });
    }

    if (req.method === "POST" && url.pathname === "/close") {
      const body = await readJson(req);
      const scope = body?.scope === "page" ? "page" : "context";
      if (scope === "page") {
        await closePage();
      } else {
        await closeContext();
      }
      return sendJson(res, 200, { status: "ok", scope });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendError(res, error);
  }
});

const shutdown = async (signal) => {
  try {
    await closeContext();
  } catch (error) {
    console.error(`Shutdown error (${signal}):`, error);
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2_000).unref();
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const startServer = async () => {
  await ensureConfig();
  await ensureOutputDir();
  server.listen(config.port, () => {
    console.log(
      `Playwright microservice listening on http://localhost:${config.port} (browser=${config.browser}, headless=${config.headless})`,
    );
    if (config.startUrl) {
      console.log(`Auto-start URL: ${config.startUrl}`);
    }
    console.log(`Storage dir: ${config.storageDir}`);
    console.log(`Output dir: ${config.outputDir}`);
  });
};

startServer();
