import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeToWav } from "./media.js";
import { transcribeWav } from "./asr.js";
import { translateLines } from "./translate.js";

export async function analyzeCaptureChunk({
  audioBuffer,
  startMs = 0,
  ffmpegBin = "ffmpeg",
  apiKey,
  translate = true
}) {
  const directory = await mkdtemp(join(tmpdir(), "koe-cap-"));
  try {
    const inputPath = join(directory, "chunk.webm");
    const wavPath = join(directory, "chunk.wav");
    await writeFile(inputPath, audioBuffer);
    await normalizeToWav({ inputPath, outputPath: wavPath, ffmpegBin });
    const audio = await readFile(wavPath);
    const chunkMs = Math.max(500, Math.round((audio.length - 44) / 32));
    let lines = await transcribeWav({ audio, startMs: 0, endMs: chunkMs, apiKey });
    if (translate && lines.length) {
      lines = await translateLines({ lines, apiKey }).catch(() => lines);
    }
    return lines.map((line) => ({
      ...line,
      startMs: line.startMs + startMs,
      endMs: line.endMs + startMs
    }));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
