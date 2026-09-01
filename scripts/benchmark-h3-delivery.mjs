import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

function parseEnv(text) {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    if (line.slice(0, separator).trim() !== "FAL_KEY") continue;
    const rawValue = line.slice(separator + 1).trim();
    return rawValue.replace(/^(["'])(.*)\1$/u, "$2");
  }
  return "";
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];

  return {
    min: Number(sorted[0].toFixed(3)),
    median: Number(median.toFixed(3)),
    mean: Number(mean.toFixed(3)),
    max: Number(sorted.at(-1).toFixed(3)),
  };
}

const apiKey = process.env.FAL_KEY || parseEnv(await readFile(resolve(".env"), "utf8"));
if (!apiKey) throw new Error("FAL_KEY is unavailable");

const prompt = (await readFile(resolve(".h3-max-prompt.txt"), "utf8")).trim();
const syncMode = (process.env.H3_SYNC_MODE ?? "false").toLowerCase() === "true";
const runs = Number.parseInt(process.env.H3_BENCH_RUNS ?? "3", 10);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
  throw new Error("H3_BENCH_RUNS must be an integer from 1 through 10");
}

const results = [];
for (let index = 0; index < runs; index += 1) {
  const startedAt = performance.now();
  const response = await fetch("https://fal.run/minimax/h3-max/text-to-video", {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      duration: 5,
      resolution: "480P",
      aspect_ratio: "16:9",
      prompt_expansion_mode: "balanced",
      enable_safety_checker: true,
      sync_mode: syncMode,
    }),
  });
  const headersAt = performance.now();
  const responseText = await response.text();
  const finishedAt = performance.now();
  if (!response.ok) {
    throw new Error(`fal request failed (${response.status}): ${responseText}`);
  }

  const result = JSON.parse(responseText);
  const videoUrl = result?.video?.url;
  if (!videoUrl) throw new Error("fal returned no video URL");

  const item = {
    run: index + 1,
    headers_seconds: Number(((headersAt - startedAt) / 1000).toFixed(3)),
    body_seconds: Number(((finishedAt - headersAt) / 1000).toFixed(3)),
    usable_video_seconds: Number(((finishedAt - startedAt) / 1000).toFixed(3)),
    delivery: videoUrl.startsWith("data:") ? "inline_data_url" : "remote_url",
    response_bytes: Buffer.byteLength(responseText),
    provider_timings: result.timings ?? null,
  };
  results.push(item);
  console.log(JSON.stringify(item));
}

const report = {
  model: "minimax/h3-max/text-to-video",
  duration: 5,
  resolution: "480P",
  sync_mode: syncMode,
  runs,
  usable_video_seconds: summarize(results.map((result) => result.usable_video_seconds)),
  results,
};

const outputDir = resolve("outputs", "benchmarks", "h3-delivery");
await mkdir(outputDir, { recursive: true });
const reportPath = resolve(outputDir, `sync-${syncMode}-${Date.now()}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ summary: report.usable_video_seconds, report_path: reportPath }, null, 2));
