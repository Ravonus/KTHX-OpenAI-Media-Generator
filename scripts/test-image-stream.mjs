#!/usr/bin/env node
import process from "node:process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv) => {
  const options = {
    port: Number(process.env.PW_PORT || 4280),
    pollMs: 1200,
    timeoutMs: 180000,
    url: "https://chatgpt.com",
    prompt: "Generate an image of a red fox in neon city lights.",
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--port" && argv[i + 1]) {
      options.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--poll" && argv[i + 1]) {
      options.pollMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--timeout" && argv[i + 1]) {
      options.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--url" && argv[i + 1]) {
      options.url = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--prompt" && argv[i + 1]) {
      options.prompt = argv[i + 1];
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    options.prompt = positional.join(" ");
  }
  return options;
};

const printUsage = () => {
  console.log(`Usage:
  node scripts/test-image-stream.mjs [--prompt "..."] [--port 4280] [--poll 1200] [--timeout 180000] [--url https://chatgpt.com]

Examples:
  node scripts/test-image-stream.mjs --prompt "Generate an image of a mountain at sunrise"
  node scripts/test-image-stream.mjs "Generate an image of a green dragon"
`);
};

const fetchJson = async (url, options = undefined) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }
  return data;
};

const eventLine = (event) => {
  const ts = event?.ts || new Date().toISOString();
  const type = event?.type || "event";
  const source = event?.source ? ` source=${event.source}` : "";
  const metadataId = event?.metadataId ? ` metadata=${event.metadataId}` : "";
  const fileName = event?.fileName ? ` file=${event.fileName}` : "";
  const outputPath = event?.outputPath ? ` path=${event.outputPath}` : "";
  const msg = event?.message ? ` msg="${event.message}"` : "";
  return `[${ts}] ${type}${source}${metadataId}${fileName}${outputPath}${msg}`;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error(`Invalid --port value: ${options.port}`);
  }
  if (!Number.isFinite(options.pollMs) || options.pollMs < 200) {
    throw new Error(`Invalid --poll value: ${options.pollMs}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error(`Invalid --timeout value: ${options.timeoutMs}`);
  }

  const baseUrl = `http://localhost:${options.port}`;
  console.log(`Posting image stream run to ${baseUrl}/open`);
  console.log(`Prompt: ${options.prompt}`);

  const openResult = await fetchJson(`${baseUrl}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: options.url,
      prompt: options.prompt,
      mode: "image",
      command: "generateImage",
      stream: true,
      sync: false,
    }),
  });

  console.log("Open response:", JSON.stringify(openResult, null, 2));
  const contextId = openResult?.contextId;
  if (!contextId) {
    throw new Error("No contextId returned from /open.");
  }

  console.log(`Polling /context for ${contextId} ...`);
  let seenStreamEvents = 0;
  let lastStatus = "";
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const contextResponse = await fetchJson(
      `${baseUrl}/context?id=${encodeURIComponent(contextId)}`,
    );
    const context = contextResponse?.context || {};
    const status = context?.status || "unknown";
    if (status !== lastStatus) {
      lastStatus = status;
      console.log(`[status] ${status}`);
    }

    const streamEvents = Array.isArray(context?.streamEvents)
      ? context.streamEvents
      : [];
    for (let i = seenStreamEvents; i < streamEvents.length; i += 1) {
      console.log(eventLine(streamEvents[i]));
    }
    seenStreamEvents = streamEvents.length;

    if (status === "completed" || status === "error") {
      const result = context?.result || {};
      console.log("Final context result:", JSON.stringify(result, null, 2));
      if (status === "error") {
        process.exitCode = 1;
      }
      return;
    }

    await sleep(options.pollMs);
  }

  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for context ${contextId}.`,
  );
};

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});

