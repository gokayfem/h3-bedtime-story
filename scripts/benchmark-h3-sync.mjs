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

const apiKey = process.env.FAL_KEY || parseEnv(await readFile(resolve(".env"), "utf8"));
if (!apiKey) throw new Error("FAL_KEY is unavailable");

const prompt = (await readFile(resolve(".h3-max-prompt.txt"), "utf8")).trim();
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
    sync_mode: true,
  }),
});
const responseText = await response.text();
const apiFinishedAt = performance.now();
if (!response.ok) throw new Error(`fal request failed (${response.status}): ${responseText}`);

const result = JSON.parse(responseText);
const videoUrl = result?.video?.url;
if (!videoUrl) throw new Error("fal returned no video URL");

let videoBytes;
let delivery;
if (videoUrl.startsWith("data:")) {
  const comma = videoUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid video data URL");
  const header = videoUrl.slice(0, comma);
  const payload = videoUrl.slice(comma + 1);
  videoBytes = Buffer.from(payload, header.endsWith(";base64") ? "base64" : "utf8");
  delivery = "inline_data_url";
} else {
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) throw new Error(`Video download failed (${videoResponse.status})`);
  videoBytes = Buffer.from(await videoResponse.arrayBuffer());
  delivery = "remote_url";
}

const finishedAt = performance.now();
const outputDir = resolve("outputs", "benchmarks", "5s-sync-true");
await mkdir(outputDir, { recursive: true });
const videoPath = resolve(outputDir, "h3-max-5s-sync-true.mp4");
await writeFile(videoPath, videoBytes);

console.log(JSON.stringify({
  duration: 5,
  resolution: "480P",
  sync_mode: true,
  delivery,
  provider_timings: result.timings ?? null,
  api_wall_seconds: Number(((apiFinishedAt - startedAt) / 1000).toFixed(3)),
  post_response_seconds: Number(((finishedAt - apiFinishedAt) / 1000).toFixed(3)),
  total_wall_seconds: Number(((finishedAt - startedAt) / 1000).toFixed(3)),
  response_bytes: Buffer.byteLength(responseText),
  video_bytes: videoBytes.byteLength,
  video_path: videoPath,
}, null, 2));
