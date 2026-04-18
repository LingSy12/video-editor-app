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
  renderMode: "auto-gpu",
  videoBitrate: "auto",
  audioBitrate: "192k",
});

const VIDEO_ENCODERS = Object.freeze([
  { id: "h264_nvenc", label: "NVIDIA NVENC", hardware: true, order: 1 },
  { id: "h264_qsv", label: "Intel Quick Sync", hardware: true, order: 2 },
  { id: "h264_amf", label: "AMD AMF", hardware: true, order: 3 },
  { id: "libx264", label: "Software x264", hardware: false, order: 99 },
]);

let capabilityCache = null;

function normalizeExportSettings(settings) {
  return {
    width: clampInteger(settings.width, DEFAULT_EXPORT_SETTINGS.width, 320, 7680),
    height: clampInteger(settings.height, DEFAULT_EXPORT_SETTINGS.height, 240, 4320),
    fps: clampInteger(settings.fps, DEFAULT_EXPORT_SETTINGS.fps, 12, 60),
    crf: clampInteger(settings.crf, DEFAULT_EXPORT_SETTINGS.crf, 12, 35),
    videoPreset: normalizePreset(settings.videoPreset),
    renderMode: normalizeRenderMode(settings.renderMode),
    videoBitrate: normalizeVideoBitrate(settings.videoBitrate),
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

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
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

function normalizeRenderMode(value) {
  return value === "software" ? "software" : DEFAULT_EXPORT_SETTINGS.renderMode;
}

function normalizeVideoBitrate(value) {
  if (!value || value === "auto") {
    return DEFAULT_EXPORT_SETTINGS.videoBitrate;
  }

  const match = String(value).match(/^(\d{3,6})k$/i);
  if (!match) {
    return DEFAULT_EXPORT_SETTINGS.videoBitrate;
  }

  const bitrate = Number.parseInt(match[1], 10);
  if (bitrate < 2_000 || bitrate > 120_000) {
    return DEFAULT_EXPORT_SETTINGS.videoBitrate;
  }

  return `${bitrate}k`;
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

function parseBitrateKbps(value, fallback = 0) {
  const match = String(value || "").match(/^(\d{2,6})k$/i);
  if (!match) {
    return fallback;
  }

  return Number.parseInt(match[1], 10);
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function estimateAutoVideoBitrateKbps(settings) {
  const normalized = normalizeExportSettings(settings || {});
  const baseline = (normalized.width * normalized.height * normalized.fps) / (1920 * 1080 * 30);
  const bitrate = 12_000 * Math.pow(Math.max(baseline, 0.2), 0.86);
  return Math.max(4_000, Math.min(80_000, roundToStep(bitrate, 500)));
}

function resolveVideoBitrateKbps(settings) {
  const normalized = normalizeExportSettings(settings || {});
  if (normalized.videoBitrate === "auto") {
    return estimateAutoVideoBitrateKbps(normalized);
  }

  return parseBitrateKbps(normalized.videoBitrate, estimateAutoVideoBitrateKbps(normalized));
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

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "Calculating";
  }

  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  }

  return `${secs}s`;
}

function estimateRenderSeconds(totalDuration, settings, encoder) {
  const normalized = normalizeExportSettings(settings || {});
  const pixelLoad = (normalized.width * normalized.height * normalized.fps) / (1920 * 1080 * 30);
  const presetFactor = {
    ultrafast: 0.6,
    superfast: 0.7,
    veryfast: 0.8,
    faster: 0.9,
    fast: 1.0,
    medium: 1.12,
    slow: 1.3,
    slower: 1.5,
    veryslow: 1.75,
  }[normalized.videoPreset];
  const baseFactor = encoder?.hardware ? 0.55 : 1.05;
  return Number(
    (totalDuration * baseFactor * Math.pow(Math.max(pixelLoad, 0.25), 0.92) * presetFactor).toFixed(1),
  );
}

function estimateOutputSizeBytes(totalDuration, videoBitrateKbps, audioBitrateKbps) {
  const totalBitrate = Math.max(1, videoBitrateKbps + audioBitrateKbps);
  const bytes = (totalDuration * totalBitrate * 1000) / 8;
  return Math.round(bytes * 1.03);
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

function getEncoderInfo(id) {
  return VIDEO_ENCODERS.find((encoder) => encoder.id === id) || VIDEO_ENCODERS[VIDEO_ENCODERS.length - 1];
}

function createFallbackCapabilities() {
  return {
    encoders: [getEncoderInfo("libx264")],
    preferredEncoder: getEncoderInfo("libx264"),
    detectedHardwareEncoder: null,
  };
}

function getRenderCapabilities(ffmpegPath) {
  if (capabilityCache?.ffmpegPath === ffmpegPath && capabilityCache?.promise) {
    return capabilityCache.promise;
  }

  const promise = new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, ["-hide_banner", "-encoders"], {
      windowsHide: true,
    });

    let output = "";

    ffmpeg.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    ffmpeg.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    ffmpeg.on("error", () => {
      resolve(createFallbackCapabilities());
    });

    ffmpeg.on("close", () => {
      const available = VIDEO_ENCODERS.filter((encoder) => {
        return encoder.id === "libx264" || output.includes(encoder.id);
      }).sort((left, right) => left.order - right.order);

      const encoders = available.length > 0 ? available : [getEncoderInfo("libx264")];
      const preferredEncoder =
        encoders.find((encoder) => encoder.hardware) || getEncoderInfo("libx264");

      resolve({
        encoders,
        preferredEncoder,
        detectedHardwareEncoder: encoders.find((encoder) => encoder.hardware) || null,
      });
    });
  });

  capabilityCache = {
    ffmpegPath,
    promise,
  };

  return promise;
}

function selectVideoEncoder(capabilities, renderMode) {
  if (renderMode === "software") {
    return getEncoderInfo("libx264");
  }

  return capabilities?.preferredEncoder || getEncoderInfo("libx264");
}

function appendBitrateArgs(args, bitrateKbps) {
  const safeBitrate = Math.max(2_000, Math.round(bitrateKbps));
  args.push("-b:v", `${safeBitrate}k`);
  args.push("-maxrate:v", `${Math.round(safeBitrate * 1.35)}k`);
  args.push("-bufsize:v", `${Math.round(safeBitrate * 2)}k`);
}

function appendVideoEncoderArgs(args, settings, encoder) {
  args.push("-c:v", encoder.id);

  if (encoder.id === "libx264") {
    args.push("-preset", settings.videoPreset);
    if (settings.videoBitrate === "auto") {
      args.push("-crf", String(settings.crf));
    } else {
      appendBitrateArgs(args, resolveVideoBitrateKbps(settings));
    }
  } else {
    appendBitrateArgs(args, resolveVideoBitrateKbps(settings));

    if (encoder.id === "h264_nvenc") {
      args.push("-rc:v", "vbr");
      args.push("-cq:v", String(Math.max(16, Math.min(28, settings.crf))));
    }
  }

  args.push("-pix_fmt", "yuv420p");
}

function buildExportPlan(clips, rawSettings) {
  const settings = normalizeExportSettings(rawSettings);
  const encoder = getEncoderInfo(rawSettings?.videoEncoder || "libx264");
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
      Math.min(sourceDuration, trimStart + 0.001),
      Math.max(sourceDuration, trimStart + 0.001),
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
  appendVideoEncoderArgs(args, settings, encoder);
  args.push("-c:a", "aac");
  args.push("-b:a", settings.audioBitrate);
  args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:1", "-nostats");

  const totalDuration = Number(
    normalizedClips.reduce((sum, clip) => sum + clip.duration, 0).toFixed(3),
  );
  const videoBitrateKbps = resolveVideoBitrateKbps(settings);
  const audioBitrateKbps = parseBitrateKbps(settings.audioBitrate, 192);
  const estimatedFileSizeBytes = estimateOutputSizeBytes(
    totalDuration,
    videoBitrateKbps,
    audioBitrateKbps,
  );
  const estimatedRenderSeconds = estimateRenderSeconds(totalDuration, settings, encoder);

  return {
    args,
    totalDuration,
    settings,
    clips: normalizedClips,
    encoder,
    resolvedVideoBitrateKbps: videoBitrateKbps,
    resolvedAudioBitrateKbps: audioBitrateKbps,
    estimatedFileSizeBytes,
    estimatedRenderSeconds,
  };
}

async function summarizeExportSettings({ clips, settings, ffmpegPath }) {
  const capabilities = await getRenderCapabilities(ffmpegPath);
  const encoder = selectVideoEncoder(capabilities, settings?.renderMode);
  const plan = buildExportPlan(clips, {
    ...settings,
    videoEncoder: encoder.id,
  });

  return {
    clipCount: plan.clips.length,
    totalDuration: plan.totalDuration,
    estimatedFileSizeBytes: plan.estimatedFileSizeBytes,
    estimatedFileSizeLabel: humanFileSize(plan.estimatedFileSizeBytes),
    estimatedRenderSeconds: plan.estimatedRenderSeconds,
    estimatedRenderLabel: formatEta(plan.estimatedRenderSeconds),
    resolvedVideoBitrateKbps: plan.resolvedVideoBitrateKbps,
    resolvedAudioBitrateKbps: plan.resolvedAudioBitrateKbps,
    resolvedVideoBitrateLabel: `${plan.resolvedVideoBitrateKbps} kbps`,
    encoder: plan.encoder.id,
    encoderLabel: plan.encoder.label,
    usingHardwareEncoder: plan.encoder.hardware,
    availableEncoders: capabilities.encoders,
  };
}

function parseSpeed(value) {
  const numeric = Number.parseFloat(String(value || "").replace(/x$/i, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

async function runExport({ clips, outputPath, settings, ffmpegPath, onProgress }) {
  if (!outputPath) {
    throw new Error("Choose an export destination before rendering.");
  }

  const capabilities = await getRenderCapabilities(ffmpegPath);
  const encoder = selectVideoEncoder(capabilities, settings?.renderMode);
  const plan = buildExportPlan(clips, {
    ...settings,
    videoEncoder: encoder.id,
  });
  const args = [...plan.args, outputPath];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
    });

    let stderr = "";
    let stdoutBuffer = "";
    const startedAt = Date.now();

    if (typeof onProgress === "function") {
      onProgress({
        percent: 0,
        status: "starting",
        currentTimeSeconds: 0,
        totalDuration: plan.totalDuration,
        etaSeconds: plan.estimatedRenderSeconds,
        estimatedFinalSizeBytes: plan.estimatedFileSizeBytes,
        outputSizeBytes: 0,
        speedMultiplier: null,
        encoder: plan.encoder.id,
        encoderLabel: plan.encoder.label,
        usingHardwareEncoder: plan.encoder.hardware,
      });
    }

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

        if (key === "progress" && typeof onProgress === "function") {
          const outTimeMs = Number(progressPacket.out_time_ms || 0);
          const currentTimeSeconds = Number((outTimeMs / 1_000_000).toFixed(3));
          const ratio = plan.totalDuration > 0 ? currentTimeSeconds / plan.totalDuration : 0;
          const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
          const elapsedSeconds = (Date.now() - startedAt) / 1000;
          const totalSizeBytes = Number(progressPacket.total_size || 0);
          const estimatedFinalSizeBytes =
            totalSizeBytes > 0 && ratio > 0.02
              ? Math.round(totalSizeBytes / Math.max(ratio, 0.001))
              : plan.estimatedFileSizeBytes;
          const etaSeconds =
            ratio > 0.005 && percent < 100
              ? Math.max(0, elapsedSeconds * ((1 - ratio) / ratio))
              : 0;

          onProgress({
            percent,
            status: value === "end" ? "finalizing" : "rendering",
            currentTimeSeconds,
            totalDuration: plan.totalDuration,
            etaSeconds,
            estimatedFinalSizeBytes,
            outputSizeBytes: totalSizeBytes,
            speedMultiplier: parseSpeed(progressPacket.speed),
            encoder: plan.encoder.id,
            encoderLabel: plan.encoder.label,
            usingHardwareEncoder: plan.encoder.hardware,
          });
        }
      });
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`Unable to start FFmpeg: ${error.message}`));
    });

    ffmpeg.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
        return;
      }

      const outputStats = await fs.promises.stat(outputPath).catch(() => null);
      const outputSizeBytes = outputStats?.size || plan.estimatedFileSizeBytes;

      if (typeof onProgress === "function") {
        onProgress({
          percent: 100,
          status: "done",
          currentTimeSeconds: plan.totalDuration,
          totalDuration: plan.totalDuration,
          etaSeconds: 0,
          estimatedFinalSizeBytes: outputSizeBytes,
          outputSizeBytes,
          speedMultiplier: null,
          encoder: plan.encoder.id,
          encoderLabel: plan.encoder.label,
          usingHardwareEncoder: plan.encoder.hardware,
        });
      }

      resolve({
        outputPath,
        totalDuration: plan.totalDuration,
        clipCount: plan.clips.length,
        settings: plan.settings,
        encoder: plan.encoder.id,
        encoderLabel: plan.encoder.label,
        usingHardwareEncoder: plan.encoder.hardware,
        outputSizeBytes,
        outputSizeLabel: humanFileSize(outputSizeBytes),
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
        "-vf",
        "scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "27",
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
  getRenderCapabilities,
  humanFileSize,
  normalizeExportSettings,
  preparePreviewMedia,
  probeMedia,
  runExport,
  summarizeExportSettings,
};
