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
  renderMode: "force-gpu",
  videoBitrate: "auto",
});

const SOFTWARE_ENCODER = Object.freeze({
  name: "libx264",
  label: "Software x264",
  type: "software",
});

const HARDWARE_ENCODER_CANDIDATES = Object.freeze([
  {
    name: "h264_nvenc",
    label: "NVIDIA NVENC H.264",
    type: "hardware",
    vendor: "nvidia",
    retryPattern: /nvenc|nvidia|cuda|device|driver/i,
  },
  {
    name: "h264_qsv",
    label: "Intel Quick Sync H.264",
    type: "hardware",
    vendor: "intel",
    retryPattern: /qsv|quick sync|mfx|device|unsupported/i,
  },
  {
    name: "h264_amf",
    label: "AMD AMF H.264",
    type: "hardware",
    vendor: "amd",
    retryPattern: /amf|amd|device|driver/i,
  },
  {
    name: "h264_mf",
    label: "Windows Media Foundation H.264",
    type: "hardware",
    vendor: "windows",
    retryPattern: /media foundation|mediafoundation|\bmf\b/i,
  },
]);

const HARDWARE_VIDEO_PIPELINE_CANDIDATES = Object.freeze([
  {
    name: "cuda-scale",
    label: "CUDA scaling",
    vendor: "nvidia",
    retryPattern: /scale_cuda|hwupload_cuda|hwdownload|cuda|nvidia|device|driver/i,
  },
]);

const PRESET_SPEED_FACTORS = Object.freeze({
  ultrafast: 2.2,
  superfast: 1.9,
  veryfast: 1.6,
  faster: 1.35,
  fast: 1.18,
  medium: 1,
  slow: 0.78,
  slower: 0.62,
  veryslow: 0.48,
});

let renderCapabilitiesCache = null;

const HARDWARE_PROBE_FILTER = "color=c=black:s=128x128:r=30:d=0.1";

function normalizeExportSettings(settings) {
  return {
    width: normalizeDimension(settings.width, DEFAULT_EXPORT_SETTINGS.width, 320, 7680),
    height: normalizeDimension(settings.height, DEFAULT_EXPORT_SETTINGS.height, 240, 4320),
    fps: clampInteger(settings.fps, DEFAULT_EXPORT_SETTINGS.fps, 12, 60),
    crf: clampInteger(settings.crf, DEFAULT_EXPORT_SETTINGS.crf, 12, 35),
    videoPreset: normalizePreset(settings.videoPreset),
    audioBitrate: normalizeAudioBitrate(settings.audioBitrate),
    renderMode: normalizeRenderMode(settings.renderMode),
    videoBitrate: normalizeVideoBitrate(settings.videoBitrate),
  };
}

function normalizeDimension(value, fallback, min, max) {
  const numeric = clampInteger(value, fallback, min, max);
  if (numeric % 2 === 0) {
    return numeric;
  }

  return Math.max(min, numeric - 1);
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

function normalizeRenderMode(value) {
  const supportedModes = new Set(["force-gpu", "auto-gpu", "software"]);
  return supportedModes.has(value) ? value : DEFAULT_EXPORT_SETTINGS.renderMode;
}

function normalizeVideoBitrate(value) {
  if (String(value || "").toLowerCase() === "auto") {
    return "auto";
  }

  const match = String(value || "").match(/^(\d{3,6})k$/i);
  if (!match) {
    return DEFAULT_EXPORT_SETTINGS.videoBitrate;
  }

  const bitrate = Number.parseInt(match[1], 10);
  if (bitrate < 1500 || bitrate > 120000) {
    return DEFAULT_EXPORT_SETTINGS.videoBitrate;
  }

  return `${bitrate}k`;
}

function formatSeconds(value) {
  return Number(value).toFixed(3);
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "Under 1s";
  }

  const whole = Math.round(seconds);
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

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / 1024 ** exponent;
  return `${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
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

function parseBitrateKbps(value) {
  const match = String(value || "").match(/^(\d{2,6})k$/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseSpeedMultiplier(value) {
  const match = String(value || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)x$/i);
  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveVideoBitrateKbps(settings) {
  if (settings.videoBitrate !== "auto") {
    return parseBitrateKbps(settings.videoBitrate);
  }

  const baselinePixelsPerSecond = 1920 * 1080 * 30;
  const targetPixelsPerSecond = settings.width * settings.height * settings.fps;
  const scaled = 10000 * (targetPixelsPerSecond / baselinePixelsPerSecond);
  const rounded = Math.round(scaled / 250) * 250;
  return clampInteger(rounded, 10000, 2500, 80000);
}

function estimateFileSizeBytes(totalDuration, videoBitrateKbps, audioBitrateKbps) {
  const combinedBitrateBps = (videoBitrateKbps + audioBitrateKbps) * 1000;
  return Math.max(0, Math.round((combinedBitrateBps / 8) * totalDuration * 1.03));
}

function estimateRenderSeconds(totalDuration, settings, encoder, clipCount, videoPipeline = null) {
  const baseSpeed = encoder.type === "hardware" ? (videoPipeline ? 2.3 : 1.9) : 0.95;
  const presetFactor = PRESET_SPEED_FACTORS[settings.videoPreset] || 1;
  const complexity = (settings.width * settings.height * settings.fps) / (1920 * 1080 * 30);
  const complexityPenalty = Math.max(0.55, complexity ** 0.72);
  const clipPenalty = 1 + Math.max(0, clipCount - 1) * 0.035;
  const speedMultiplier = Math.max(
    0.15,
    Number(((baseSpeed * presetFactor) / complexityPenalty / clipPenalty).toFixed(2)),
  );

  return {
    speedMultiplier,
    estimatedSeconds: Number((totalDuration / speedMultiplier).toFixed(1)),
  };
}

function mapNvencPreset(preset) {
  switch (preset) {
    case "ultrafast":
    case "superfast":
    case "veryfast":
      return "p2";
    case "faster":
    case "fast":
      return "p3";
    case "slow":
    case "slower":
    case "veryslow":
      return "p6";
    case "medium":
    default:
      return "p4";
  }
}

function getHardwareVideoPipelineDefinition(name) {
  return HARDWARE_VIDEO_PIPELINE_CANDIDATES.find((candidate) => candidate.name === name) || null;
}

function buildPipelineLabel(encoder, videoPipeline) {
  if (!encoder) {
    return "";
  }

  if (encoder.type !== "hardware") {
    return encoder.label;
  }

  if (videoPipeline?.label) {
    return `${encoder.label} + ${videoPipeline.label}`;
  }

  return `${encoder.label} + CPU filters`;
}

function buildCpuVideoStages(settings) {
  return [
    `scale=w=${settings.width}:h=${settings.height}:force_original_aspect_ratio=decrease`,
    `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${settings.fps}`,
    "format=yuv420p",
    "setsar=1",
    "setpts=PTS-STARTPTS",
  ];
}

function buildCudaScaleVideoStages(settings) {
  return [
    "format=nv12",
    "hwupload_cuda",
    `scale_cuda=w=${settings.width}:h=${settings.height}:force_original_aspect_ratio=decrease:format=nv12`,
    "hwdownload",
    "format=nv12",
    `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${settings.fps}`,
    "format=yuv420p",
    "setsar=1",
    "setpts=PTS-STARTPTS",
  ];
}

function buildVideoStages(settings, videoPipeline) {
  if (videoPipeline?.name === "cuda-scale") {
    return buildCudaScaleVideoStages(settings);
  }

  return buildCpuVideoStages(settings);
}

function buildVideoFilterChain({ inputTag = "", outputTag = "", settings, videoPipeline }) {
  const stages = buildVideoStages(settings, videoPipeline);
  return `${inputTag}${stages.join(",")}${outputTag ? `[${outputTag}]` : ""}`;
}

function buildVideoEncoderArgs(settings, encoder, videoBitrateKbps) {
  const args = ["-c:v", encoder.name];

  if (encoder.name === SOFTWARE_ENCODER.name) {
    args.push("-preset", settings.videoPreset);
  } else if (encoder.name === "h264_nvenc") {
    args.push("-preset", mapNvencPreset(settings.videoPreset));
  }

  if (encoder.name === SOFTWARE_ENCODER.name && settings.videoBitrate === "auto") {
    args.push("-crf", String(settings.crf));
  } else {
    const maxrate = Math.round(videoBitrateKbps * 1.15);
    const bufsize = Math.round(videoBitrateKbps * 2);
    args.push("-b:v", `${videoBitrateKbps}k`);
    args.push("-maxrate", `${maxrate}k`);
    args.push("-bufsize", `${bufsize}k`);
  }

  args.push("-pix_fmt", "yuv420p");
  return args;
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function summarizeHardwareProbeError(message) {
  const normalized = collapseWhitespace(message);
  if (!normalized) {
    return "initialization failed";
  }

  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function buildHardwareAvailabilitySuffix(capabilities) {
  const usableHardwareLabels = (capabilities?.availableHardwareEncoders || [])
    .map((encoder) => encoder.label)
    .join(", ");
  if (usableHardwareLabels) {
    return ` Usable encoders: ${usableHardwareLabels}.`;
  }

  const unusableHardwareEncoders = capabilities?.unusableHardwareEncoders || [];
  if (unusableHardwareEncoders.length > 0) {
    const details = unusableHardwareEncoders
      .map((encoder) => `${encoder.label} (${encoder.probeError || "initialization failed"})`)
      .join("; ");
    return ` FFmpeg reported these GPU encoders, but they could not be initialized on this machine: ${details}.`;
  }

  return " No supported H.264 GPU encoder was detected by FFmpeg.";
}

function selectEncoder(settings, capabilities, preferredEncoder = null) {
  if (preferredEncoder) {
    return preferredEncoder;
  }

  if (settings.renderMode === "software") {
    return SOFTWARE_ENCODER;
  }

  if (capabilities?.detectedHardwareEncoder) {
    return capabilities.detectedHardwareEncoder;
  }

  if (settings.renderMode === "force-gpu") {
    throw new Error(
      `Force GPU rendering is enabled, but a usable GPU H.264 encoder is not available.${buildHardwareAvailabilitySuffix(capabilities)} Switch to Auto GPU or Software render mode, or update the GPU driver/runtime and try again.`,
    );
  }

  return SOFTWARE_ENCODER;
}

function selectVideoPipeline(capabilities, encoder, preferredVideoPipeline = null) {
  if (preferredVideoPipeline) {
    return preferredVideoPipeline;
  }

  if (encoder?.type !== "hardware" || !encoder.vendor) {
    return null;
  }

  const availableVideoPipelines = Array.isArray(capabilities?.availableVideoPipelines)
    ? capabilities.availableVideoPipelines
    : [];
  return availableVideoPipelines.find((pipeline) => pipeline.vendor === encoder.vendor) || null;
}

function parseEncoderList(output) {
  const encoders = new Set();
  output.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*\S{6}\s+([a-z0-9_]+)\s+/i);
    if (match) {
      encoders.add(match[1]);
    }
  });
  return encoders;
}

function runCommandCapture(executablePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Unable to start ${path.basename(executablePath)}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || stdout.trim() || `${path.basename(executablePath)} exited with code ${code}`,
          ),
        );
        return;
      }

      resolve({
        stdout,
        stderr,
        combined: [stdout, stderr].filter(Boolean).join("\n"),
      });
    });
  });
}

async function probeHardwareEncoder(ffmpegPath, encoder) {
  try {
    await runCommandCapture(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      HARDWARE_PROBE_FILTER,
      "-frames:v",
      "1",
      "-vf",
      "format=nv12",
      "-an",
      "-c:v",
      encoder.name,
      ...(encoder.name === "h264_nvenc" ? ["-preset", "p4"] : []),
      "-f",
      "null",
      "-",
    ]);

    return {
      ...encoder,
      probeSucceeded: true,
      probeError: null,
    };
  } catch (error) {
    return {
      ...encoder,
      probeSucceeded: false,
      probeError: summarizeHardwareProbeError(error.message),
    };
  }
}

async function probeHardwareVideoPipeline(ffmpegPath, encoder, pipeline) {
  try {
    await runCommandCapture(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      HARDWARE_PROBE_FILTER,
      "-frames:v",
      "1",
      "-vf",
      buildVideoFilterChain({
        settings: {
          width: 320,
          height: 180,
          fps: 30,
        },
        videoPipeline: pipeline,
      }),
      "-an",
      "-c:v",
      encoder.name,
      ...(encoder.name === "h264_nvenc" ? ["-preset", "p4"] : []),
      "-f",
      "null",
      "-",
    ]);

    return {
      name: pipeline.name,
      label: pipeline.label,
      vendor: pipeline.vendor,
      probeSucceeded: true,
      probeError: null,
    };
  } catch (error) {
    return {
      name: pipeline.name,
      label: pipeline.label,
      vendor: pipeline.vendor,
      probeSucceeded: false,
      probeError: summarizeHardwareProbeError(error.message),
    };
  }
}

async function getRenderCapabilities(ffmpegPath) {
  if (!ffmpegPath) {
    throw new Error("FFmpeg path is required to inspect render capabilities.");
  }

  if (renderCapabilitiesCache?.ffmpegPath === ffmpegPath) {
    return renderCapabilitiesCache.promise;
  }

  const promise = runCommandCapture(ffmpegPath, ["-hide_banner", "-encoders"])
    .then(async ({ combined }) => {
      const encoderNames = parseEncoderList(combined);
      const listedHardwareEncoders = HARDWARE_ENCODER_CANDIDATES.filter((encoder) =>
        encoderNames.has(encoder.name),
      );
      const probedHardwareEncoders = await Promise.all(
        listedHardwareEncoders.map((encoder) => probeHardwareEncoder(ffmpegPath, encoder)),
      );
      const availableHardwareEncoders = probedHardwareEncoders.filter(
        (encoder) => encoder.probeSucceeded,
      );
      const unusableHardwareEncoders = probedHardwareEncoders.filter(
        (encoder) => !encoder.probeSucceeded,
      );
      const detectedHardwareEncoder = availableHardwareEncoders[0] || null;
      const videoPipelineCandidates = detectedHardwareEncoder
        ? HARDWARE_VIDEO_PIPELINE_CANDIDATES.filter(
            (pipeline) => pipeline.vendor === detectedHardwareEncoder.vendor,
          )
        : [];
      const probedVideoPipelines = await Promise.all(
        videoPipelineCandidates.map((pipeline) =>
          probeHardwareVideoPipeline(ffmpegPath, detectedHardwareEncoder, pipeline),
        ),
      );
      const availableVideoPipelines = probedVideoPipelines.filter((pipeline) => pipeline.probeSucceeded);
      const unusableVideoPipelines = probedVideoPipelines.filter((pipeline) => !pipeline.probeSucceeded);
      const detectedVideoPipeline = availableVideoPipelines[0] || null;

      return {
        listedHardwareEncoders,
        availableHardwareEncoders,
        unusableHardwareEncoders,
        detectedHardwareEncoder,
        availableVideoPipelines,
        unusableVideoPipelines,
        detectedVideoPipeline,
        preferredEncoder: detectedHardwareEncoder || SOFTWARE_ENCODER,
        preferredPipelineLabel: buildPipelineLabel(
          detectedHardwareEncoder || SOFTWARE_ENCODER,
          detectedVideoPipeline,
        ),
        detectedPipelineLabel: buildPipelineLabel(detectedHardwareEncoder, detectedVideoPipeline),
        softwareEncoder: SOFTWARE_ENCODER,
        encoderNames: Array.from(encoderNames).sort(),
      };
    })
    .catch((error) => {
      if (renderCapabilitiesCache?.promise === promise) {
        renderCapabilitiesCache = null;
      }
      throw error;
    });

  renderCapabilitiesCache = {
    ffmpegPath,
    promise,
  };

  return promise;
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

function buildExportPlan(clips, rawSettings, options = {}) {
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

  const totalDuration = Number(
    normalizedClips.reduce((sum, clip) => sum + clip.duration, 0).toFixed(3),
  );
  const capabilities = options.capabilities || null;
  const encoder = selectEncoder(settings, capabilities, options.preferredEncoder || null);
  const videoPipeline = selectVideoPipeline(
    capabilities,
    encoder,
    options.preferredVideoPipeline || null,
  );
  const resolvedVideoBitrateKbps = resolveVideoBitrateKbps(settings);
  const audioBitrateKbps = parseBitrateKbps(settings.audioBitrate);
  const estimatedFileSizeBytes = estimateFileSizeBytes(
    totalDuration,
    resolvedVideoBitrateKbps,
    audioBitrateKbps,
  );
  const renderEstimate = estimateRenderSeconds(
    totalDuration,
    settings,
    encoder,
    normalizedClips.length,
    videoPipeline,
  );

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
      buildVideoFilterChain({
        inputTag: `[${index}:v]`,
        outputTag: `v${index}`,
        settings,
        videoPipeline,
      }),
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
  args.push(...buildVideoEncoderArgs(settings, encoder, resolvedVideoBitrateKbps));
  args.push("-c:a", "aac");
  args.push("-b:a", settings.audioBitrate);
  args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:1", "-nostats");

  return {
    args,
    totalDuration,
    settings,
    clips: normalizedClips,
    encoder,
    encoderLabel: encoder.label,
    videoPipeline,
    pipelineLabel: buildPipelineLabel(encoder, videoPipeline),
    usingHardwareEncoder: encoder.type === "hardware",
    usingHardwareVideoPipeline: Boolean(videoPipeline),
    resolvedVideoBitrateKbps,
    audioBitrateKbps,
    estimatedFileSizeBytes,
    estimatedFileSizeLabel: humanFileSize(estimatedFileSizeBytes),
    estimatedRenderSeconds: renderEstimate.estimatedSeconds,
    estimatedRenderLabel: formatEta(renderEstimate.estimatedSeconds),
    estimatedSpeedMultiplier: renderEstimate.speedMultiplier,
  };
}

function summarizeExportSettings({ clips, settings, ffmpegPath }) {
  return getRenderCapabilities(ffmpegPath).then((capabilities) => {
    const plan = buildExportPlan(clips, settings, { capabilities });
    return {
      width: plan.settings.width,
      height: plan.settings.height,
      encoderLabel: plan.encoderLabel,
      pipelineLabel: plan.pipelineLabel,
      usingHardwareEncoder: plan.usingHardwareEncoder,
      usingHardwareVideoPipeline: plan.usingHardwareVideoPipeline,
      resolvedVideoBitrateKbps: plan.resolvedVideoBitrateKbps,
      estimatedFileSizeBytes: plan.estimatedFileSizeBytes,
      estimatedFileSizeLabel: plan.estimatedFileSizeLabel,
      estimatedRenderSeconds: plan.estimatedRenderSeconds,
      estimatedRenderLabel: plan.estimatedRenderLabel,
      estimatedSpeedMultiplier: plan.estimatedSpeedMultiplier,
      totalDuration: plan.totalDuration,
    };
  });
}

function shouldRetryWithSoftware(error, plan) {
  if (!plan?.usingHardwareEncoder || plan?.settings?.renderMode !== "auto-gpu") {
    return false;
  }

  const errorText = `${error?.message || ""}\n${error?.stderr || ""}`;
  const candidate = HARDWARE_ENCODER_CANDIDATES.find((encoder) => encoder.name === plan.encoder.name);
  const videoPipelineCandidate = getHardwareVideoPipelineDefinition(plan.videoPipeline?.name);

  return (
    candidate?.retryPattern?.test(errorText) ||
    videoPipelineCandidate?.retryPattern?.test(errorText) ||
    /error while opening encoder|unknown encoder|no device|initialization failed|cannot load|unsupported/i.test(
      errorText,
    )
  );
}

function executeExportPlan({ ffmpegPath, plan, outputPath, onProgress }) {
  const args = [...plan.args, outputPath];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
    });

    let stderr = "";
    let stdoutBuffer = "";
    let lastProgress = -1;
    let progressPacket = {};

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      lines.forEach((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) {
          return;
        }

        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        progressPacket[key] = value;

        if (key !== "progress") {
          return;
        }

        const outTimeMs = Number(progressPacket.out_time_ms || 0);
        const currentTimeSeconds = Number((outTimeMs / 1_000_000).toFixed(2));
        const ratio = plan.totalDuration > 0 ? currentTimeSeconds / plan.totalDuration : 0;
        const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        const speedMultiplier = parseSpeedMultiplier(progressPacket.speed);
        const encodedBytes = Number(progressPacket.total_size || 0);
        const estimatedFinalSizeBytes =
          currentTimeSeconds > 0 && encodedBytes > 0
            ? Math.round((encodedBytes / currentTimeSeconds) * plan.totalDuration)
            : plan.estimatedFileSizeBytes;
        const etaSeconds =
          speedMultiplier && speedMultiplier > 0
            ? Math.max(0, Number(((plan.totalDuration - currentTimeSeconds) / speedMultiplier).toFixed(1)))
            : plan.estimatedRenderSeconds;

        if (percent !== lastProgress && typeof onProgress === "function") {
          lastProgress = percent;
          onProgress({
            percent,
            status: value === "end" ? "finalizing" : "rendering",
            currentTimeSeconds,
            totalDuration: plan.totalDuration,
            etaSeconds,
            estimatedFinalSizeBytes,
            speedMultiplier,
            encoderLabel: plan.encoderLabel,
            pipelineLabel: plan.pipelineLabel,
          });
        }

        progressPacket = {};
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
        const failure = new Error(stderr.trim() || `FFmpeg exited with code ${code}`);
        failure.stderr = stderr;
        failure.exitCode = code;
        reject(failure);
        return;
      }

      fs.promises
        .stat(outputPath)
        .catch(() => null)
        .then((stats) => {
          const outputSizeBytes = stats?.size || 0;

          if (typeof onProgress === "function") {
            onProgress({
              percent: 100,
              status: "done",
              currentTimeSeconds: plan.totalDuration,
              totalDuration: plan.totalDuration,
              etaSeconds: 0,
              estimatedFinalSizeBytes: outputSizeBytes,
              speedMultiplier: null,
              encoderLabel: plan.encoderLabel,
              pipelineLabel: plan.pipelineLabel,
            });
          }

          resolve({
            outputPath,
            totalDuration: plan.totalDuration,
            clipCount: plan.clips.length,
            settings: plan.settings,
            encoderLabel: plan.encoderLabel,
            usingHardwareEncoder: plan.usingHardwareEncoder,
            pipelineLabel: plan.pipelineLabel,
            usingHardwareVideoPipeline: plan.usingHardwareVideoPipeline,
            resolvedVideoBitrateKbps: plan.resolvedVideoBitrateKbps,
            outputSizeBytes,
            outputSizeLabel: humanFileSize(outputSizeBytes),
          });
        })
        .catch(reject);
    });
  });
}

async function runExport({ clips, outputPath, settings, ffmpegPath, onProgress }) {
  if (!outputPath) {
    throw new Error("Choose an export destination before rendering.");
  }

  const capabilities = await getRenderCapabilities(ffmpegPath);
  const preferredPlan = buildExportPlan(clips, settings, { capabilities });

  try {
    return await executeExportPlan({
      ffmpegPath,
      plan: preferredPlan,
      outputPath,
      onProgress,
    });
  } catch (error) {
    if (preferredPlan.settings.renderMode === "force-gpu") {
      throw new Error(
        `GPU rendering is forced with ${preferredPlan.encoderLabel}, but FFmpeg could not complete the export. ${error.message}`,
      );
    }

    if (!shouldRetryWithSoftware(error, preferredPlan)) {
      throw error;
    }

    const fallbackPlan = buildExportPlan(
      clips,
      {
        ...preferredPlan.settings,
        renderMode: "software",
      },
      {
        capabilities,
        preferredEncoder: SOFTWARE_ENCODER,
      },
    );

    if (typeof onProgress === "function") {
      onProgress({
        percent: 0,
        status: "rendering",
        currentTimeSeconds: 0,
        totalDuration: fallbackPlan.totalDuration,
        etaSeconds: fallbackPlan.estimatedRenderSeconds,
        estimatedFinalSizeBytes: fallbackPlan.estimatedFileSizeBytes,
        speedMultiplier: null,
        encoderLabel: fallbackPlan.encoderLabel,
        pipelineLabel: fallbackPlan.pipelineLabel,
      });
    }

    const result = await executeExportPlan({
      ffmpegPath,
      plan: fallbackPlan,
      outputPath,
      onProgress,
    });

    return {
      ...result,
      fallbackFromHardware: true,
      fallbackReason: error.message,
    };
  }
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
  getRenderCapabilities,
  normalizeExportSettings,
  parseEncoderList,
  preparePreviewMedia,
  probeMedia,
  runExport,
  summarizeExportSettings,
};
