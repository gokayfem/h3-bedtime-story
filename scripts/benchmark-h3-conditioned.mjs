import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] ?? "";
}

function parseEnv(text) {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1 || line.slice(0, separator).trim() !== "FAL_KEY") continue;
    return line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/u, "$2");
  }
  return "";
}

function imageDataUrl(path, bytes) {
  const mime = extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const mode = option("--mode");
if (!new Set(["image", "reference"]).has(mode)) throw new Error("Use --mode image or --mode reference");
const label = option("--label") || (mode === "image" ? "image-to-video-10s" : "reference-to-video-10s");
const promptPath = resolve(option("--prompt"));
const imagePaths = process.argv.flatMap((value, index) => value === "--image" ? [resolve(process.argv[index + 1])] : []);
if (!imagePaths.length) throw new Error("Pass at least one --image");

const apiKey = process.env.FAL_KEY || parseEnv(await readFile(resolve(".env"), "utf8"));
if (!apiKey) throw new Error("FAL_KEY is unavailable");
const prompt = (await readFile(promptPath, "utf8")).trim();
const images = await Promise.all(imagePaths.map(async (path) => imageDataUrl(path, await readFile(path))));

const endpoint = mode === "image"
  ? "minimax/h3-max/image-to-video"
  : "minimax/h3-max/reference-to-video";
const input = {
  prompt,
  duration: 10,
  resolution: "480P",
  prompt_expansion_mode: "disabled",
  enable_safety_checker: true,
  sync_mode: false,
  ...(mode === "image"
    ? { image_url: images[0] }
    : { aspect_ratio: "16:9", reference_image_urls: images }),
};

const startedAt = performance.now();
const response = await fetch(`https://fal.run/${endpoint}`, {
  method: "POST",
  headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify(input),
});
const responseText = await response.text();
const apiFinishedAt = performance.now();
if (!response.ok) throw new Error(`fal request failed (${response.status}): ${responseText}`);

const result = JSON.parse(responseText);
const videoUrl = result?.video?.url;
if (!videoUrl) throw new Error("fal returned no video URL");
const videoResponse = await fetch(videoUrl);
if (!videoResponse.ok) throw new Error(`Video download failed (${videoResponse.status})`);
const videoBytes = Buffer.from(await videoResponse.arrayBuffer());
const finishedAt = performance.now();

const outputDir = resolve("outputs", "benchmarks", label);
await mkdir(outputDir, { recursive: true });
const videoPath = resolve(outputDir, `${label}.mp4`);
const metadataPath = resolve(outputDir, `${label}.json`);
await writeFile(videoPath, videoBytes);
const metadata = {
  endpoint,
  settings: { duration: 10, resolution: "480P", prompt_expansion_mode: "disabled", sync_mode: false },
  reference_count: images.length,
  reference_bytes: (await Promise.all(imagePaths.map((path) => readFile(path)))).reduce((sum, bytes) => sum + bytes.byteLength, 0),
  provider_timings: result.timings ?? null,
  seed: result.seed ?? null,
  api_wall_seconds: Number(((apiFinishedAt - startedAt) / 1000).toFixed(3)),
  download_seconds: Number(((finishedAt - apiFinishedAt) / 1000).toFixed(3)),
  total_wall_seconds: Number(((finishedAt - startedAt) / 1000).toFixed(3)),
  bytes: videoBytes.byteLength,
  video_path: videoPath,
  metadata_path: metadataPath,
};
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
