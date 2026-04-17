const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const DEFAULT_EXPORT_SETTINGS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  crf: 20,
  videoPreset: "medium",
  audioBitrate: "192k",
});

function normalizeExportSettings(settings) {
  return {
    width: clampInteger(settings.width, DEFAULT_EXPORT_SETTINGS.width, 320, 7680),
    height: clampInteger(settings.height, DEFAULT_EXPORT_SETTINGS.height, 240, 4320),
    fps: clampInteger(settings.fps, DEFAULT_EXPORT_SETTINGS.fps, 12, 60),
    crf: clampInteger(settings.crf, DEFAULT_EXPORT_SETTINGS.crf, 12, 35),
    videoPreset: normalizePreset(settings.videoPreset),
    audioBitrate: normalizeAudioBitrate(settings.audioBitrate),
  };
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numeric));
}

function normalizePreset(value) {
  const presets = new Set([
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
  ]);

  return presets.has(value) ? value : DEFAULT_EXPORT_SETTINGS.videoPreset;
}

function normalizeAudioBitrate(value) {
  const match = String(value || "").match(/^(\d{2,3})k$/i);
  if (!match) {
    return DEFAULT_EXPORT_SETTINGS.audioBitrate;
  }

  const bitrate = Number.parseInt(match[1], 10);
  if (bitrate < 64 || bitrate > 320) {
    return DEFAULT_EXPORT_SETTINGS.audioBitrate;
  }

  return `${bitrate}k`;
}

function formatSeconds(value) {
  return Number(value).toFixed(3);
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / 1024 ** exponent;
  return `${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function probeMedia(filePath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=index,codec_type,width,height,avg_frame_rate",
        "-of",
        "json",
        filePath,
      ],
      {
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";

    ffprobe.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    ffprobe.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffprobe.on("error", (error) => {
      reject(new Error(`Unable to inspect ${path.basename(filePath)}: ${error.message}`));
    });

    ffprobe.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const stats = await fs.promises.stat(filePath);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const videoStream = streams.find((stream) => stream.codec_type === "video");
        const audioStream = streams.find((stream) => stream.codec_type === "audio");
        const duration = Number.parseFloat(data?.format?.duration || "0");

        resolve({
          path: filePath,
          name: path.basename(filePath),
          duration: Number.isFinite(duration) ? duration : 0,
          width: videoStream?.width || null,
          height: videoStream?.height || null,
          hasVideo: Boolean(videoStream),
          hasAudio: Boolean(audioStream),
          fps: parseFrameRate(videoStream?.avg_frame_rate),
          sizeBytes: stats.size,
          sizeLabel: humanFileSize(stats.size),
        });
      } catch (error) {
        reject(new Error(`Unable to parse media info for ${path.basename(filePath)}: ${error.message}`));
      }
    });
  });
}

function parseFrameRate(value) {
  if (!value || typeof value !== "string" || value === "0/0") {
    return null;
  }

  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

function buildExportPlan(clips, rawSettings) {
  const settings = normalizeExportSettings(rawSettings);
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("Add at least one clip to the sequence before exporting.");
  }

  const normalizedClips = clips.map((clip, index) => {
    if (!clip?.path) {
      throw new Error(`Clip ${index + 1} is missing a file path.`);
    }

    const sourceDuration = Number(clip.sourceDuration || 0);
    const trimStart = clampNumber(clip.trimStart, 0, Math.max(sourceDuration, 0));
    const trimEnd = clampNumber(
      clip.trimEnd,
      Math.min(sourceDuration, trimStart + 0.1),
      Math.max(sourceDuration, trimStart + 0.1),
    );
    const duration = Number((trimEnd - trimStart).toFixed(3));

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`Clip "${clip.name || path.basename(clip.path)}" has no playable duration.`);
    }

    return {
      path: clip.path,
      name: clip.name || path.basename(clip.path),
      trimStart,
      trimEnd,
      duration,
      hasAudio: Boolean(clip.hasAudio),
      hasVideo: clip.hasVideo !== false,
    };
  });

  normalizedClips.forEach((clip) => {
    if (!clip.hasVideo) {
      throw new Error(`"${clip.name}" does not contain a video stream.`);
    }
  });

  const args = ["-y"];
  normalizedClips.forEach((clip) => {
    args.push("-ss", formatSeconds(clip.trimStart));
    args.push("-t", formatSeconds(clip.duration));
    args.push("-i", clip.path);
  });

  const graphSegments = [];
  const concatInputs = [];

  normalizedClips.forEach((clip, index) => {
    graphSegments.push(
      `[${index}:v]scale=w=${settings.width}:h=${settings.height}:force_original_aspect_ratio=decrease,` +
        `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `fps=${settings.fps},format=yuv420p,setsar=1,setpts=PTS-STARTPTS[v${index}]`,
    );

    if (clip.hasAudio) {
      graphSegments.push(
        `[${index}:a]aformat=channel_layouts=stereo:sample_rates=48000:sample_fmts=fltp,` +
          `aresample=48000,atrim=duration=${formatSeconds(clip.duration)},asetpts=PTS-STARTPTS[a${index}]`,
      );
    } else {
      graphSegments.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${formatSeconds(clip.duration)},asetpts=PTS-STARTPTS[a${index}]`,
      );
    }

    concatInputs.push(`[v${index}]`, `[a${index}]`);
  });

  graphSegments.push(
    `${concatInputs.join("")}concat=n=${normalizedClips.length}:v=1:a=1[vout][aout]`,
  );

  args.push("-filter_complex", graphSegments.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push("-c:v", "libx264");
  args.push("-preset", settings.videoPreset);
  args.push("-crf", String(settings.crf));
  args.push("-pix_fmt", "yuv420p");
  args.push("-c:a", "aac");
  args.push("-b:a", settings.audioBitrate);
  args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:1", "-nostats");

  const totalDuration = Number(
    normalizedClips.reduce((sum, clip) => sum + clip.duration, 0).toFixed(3),
  );

  return {
    args,
    totalDuration,
    settings,
    clips: normalizedClips,
  };
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }

  return Math.min(max, Math.max(min, numeric));
}

function runExport({ clips, outputPath, settings, ffmpegPath, onProgress }) {
  if (!outputPath) {
    throw new Error("Choose an export destination before rendering.");
  }

  const plan = buildExportPlan(clips, settings);
  const args = [...plan.args, outputPath];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
    });

    let stderr = "";
    let stdoutBuffer = "";
    let lastProgress = -1;

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      const progressPacket = {};
      lines.forEach((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) {
          return;
        }

        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        progressPacket[key] = value;

        if (key === "progress") {
          const outTimeMs = Number(progressPacket.out_time_ms || 0);
          const ratio = plan.totalDuration > 0 ? outTimeMs / 1_000_000 / plan.totalDuration : 0;
          const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));

          if (percent !== lastProgress && typeof onProgress === "function") {
            lastProgress = percent;
            onProgress({
              percent,
              status: value === "end" ? "finalizing" : "rendering",
              currentTimeSeconds: Number((outTimeMs / 1_000_000).toFixed(2)),
              totalDuration: plan.totalDuration,
            });
          }
        }
      });
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`Unable to start FFmpeg: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
        return;
      }

      if (typeof onProgress === "function") {
        onProgress({
          percent: 100,
          status: "done",
          currentTimeSeconds: plan.totalDuration,
          totalDuration: plan.totalDuration,
        });
      }

      resolve({
        outputPath,
        totalDuration: plan.totalDuration,
        clipCount: plan.clips.length,
        settings: plan.settings,
      });
    });
  });
}

async function preparePreviewMedia({ inputPath, ffmpegPath, cacheDir }) {
  if (!inputPath) {
    throw new Error("Choose a source clip before preparing a preview.");
  }

  await fs.promises.mkdir(cacheDir, { recursive: true });
  const stats = await fs.promises.stat(inputPath);
  const cacheKey = crypto
    .createHash("sha1")
    .update(`${inputPath}:${stats.size}:${stats.mtimeMs}`)
    .digest("hex");
  const outputPath = path.join(cacheDir, `${cacheKey}.mp4`);

  try {
    const existing = await fs.promises.stat(outputPath);
    if (existing.size > 0) {
      return outputPath;
    }
  } catch {
    // Cache miss, continue.
  }

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      ffmpegPath,
      [
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      {
        windowsHide: true,
      },
    );

    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`Unable to prepare preview media: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
        return;
      }

      resolve();
    });
  });

  return outputPath;
}

module.exports = {
  DEFAULT_EXPORT_SETTINGS,
  buildExportPlan,
  normalizeExportSettings,
  preparePreviewMedia,
  probeMedia,
  runExport,
};
