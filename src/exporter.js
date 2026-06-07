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
  videoCodec: "h264",
});

const SUPPORTED_VIDEO_CODECS = Object.freeze(["h264", "hevc"]);

const SOFTWARE_ENCODERS_BY_CODEC = Object.freeze({
  h264: Object.freeze({
    name: "libx264",
    label: "Software x264",
    type: "software",
    codec: "h264",
  }),
  hevc: Object.freeze({
    name: "libx265",
    label: "Software x265 (HEVC)",
    type: "software",
    codec: "hevc",
  }),
});

// Default exposed for downstream tests / legacy callers that imported the
// constant directly.
const SOFTWARE_ENCODER = SOFTWARE_ENCODERS_BY_CODEC.h264;

const HARDWARE_ENCODER_CANDIDATES = Object.freeze([
  {
    name: "h264_nvenc",
    label: "NVIDIA NVENC H.264",
    type: "hardware",
    vendor: "nvidia",
    codec: "h264",
    retryPattern: /nvenc|nvidia|cuda|device|driver/i,
  },
  {
    name: "h264_qsv",
    label: "Intel Quick Sync H.264",
    type: "hardware",
    vendor: "intel",
    codec: "h264",
    retryPattern: /qsv|quick sync|mfx|device|unsupported/i,
  },
  {
    name: "h264_amf",
    label: "AMD AMF H.264",
    type: "hardware",
    vendor: "amd",
    codec: "h264",
    retryPattern: /amf|amd|device|driver/i,
  },
  {
    name: "h264_mf",
    label: "Windows Media Foundation H.264",
    type: "hardware",
    vendor: "windows",
    codec: "h264",
    retryPattern: /media foundation|mediafoundation|\bmf\b/i,
  },
  {
    name: "hevc_nvenc",
    label: "NVIDIA NVENC H.265",
    type: "hardware",
    vendor: "nvidia",
    codec: "hevc",
    retryPattern: /nvenc|nvidia|cuda|device|driver/i,
  },
  {
    name: "hevc_qsv",
    label: "Intel Quick Sync H.265",
    type: "hardware",
    vendor: "intel",
    codec: "hevc",
    retryPattern: /qsv|quick sync|mfx|device|unsupported/i,
  },
  {
    name: "hevc_amf",
    label: "AMD AMF H.265",
    type: "hardware",
    vendor: "amd",
    codec: "hevc",
    retryPattern: /amf|amd|device|driver/i,
  },
  {
    name: "hevc_mf",
    label: "Windows Media Foundation H.265",
    type: "hardware",
    vendor: "windows",
    codec: "hevc",
    retryPattern: /media foundation|mediafoundation|\bmf\b/i,
  },
]);

function normalizeVideoCodec(value) {
  const codec = String(value || "").toLowerCase();
  return SUPPORTED_VIDEO_CODECS.includes(codec) ? codec : DEFAULT_EXPORT_SETTINGS.videoCodec;
}

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
    videoCodec: normalizeVideoCodec(settings.videoCodec),
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
  const isSoftware = encoder.type === "software";
  const isNvenc = encoder.name === "h264_nvenc" || encoder.name === "hevc_nvenc";
  const isHevc = (encoder.codec || "h264") === "hevc";

  if (isSoftware) {
    args.push("-preset", settings.videoPreset);
  } else if (isNvenc) {
    args.push("-preset", mapNvencPreset(settings.videoPreset));
  }

  if (isSoftware && settings.videoBitrate === "auto") {
    args.push("-crf", String(settings.crf));
  } else {
    const maxrate = Math.round(videoBitrateKbps * 1.15);
    const bufsize = Math.round(videoBitrateKbps * 2);
    args.push("-b:v", `${videoBitrateKbps}k`);
    args.push("-maxrate", `${maxrate}k`);
    args.push("-bufsize", `${bufsize}k`);
  }

  args.push("-pix_fmt", "yuv420p");
  if (isHevc) {
    // Tag HEVC streams as hvc1 inside MP4 so QuickTime / iOS / mainstream
    // players recognize them. The default hev1 tag plays in VLC but not in
    // Apple ecosystems.
    args.push("-tag:v", "hvc1");
  }
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

function buildHardwareAvailabilitySuffix(capabilities, codecFilter = null) {
  const filterMatch = (encoder) => !codecFilter || (encoder.codec || "h264") === codecFilter;
  const usableHardwareLabels = (capabilities?.availableHardwareEncoders || [])
    .filter(filterMatch)
    .map((encoder) => encoder.label)
    .join(", ");
  if (usableHardwareLabels) {
    return ` Usable encoders: ${usableHardwareLabels}.`;
  }

  const unusableHardwareEncoders = (capabilities?.unusableHardwareEncoders || []).filter(filterMatch);
  if (unusableHardwareEncoders.length > 0) {
    const details = unusableHardwareEncoders
      .map((encoder) => `${encoder.label} (${encoder.probeError || "initialization failed"})`)
      .join("; ");
    return ` FFmpeg reported these GPU encoders, but they could not be initialized on this machine: ${details}.`;
  }

  const codecLabel = codecFilter === "hevc" ? "H.265" : codecFilter === "h264" ? "H.264" : "";
  return codecLabel
    ? ` No supported ${codecLabel} GPU encoder was detected by FFmpeg.`
    : " No supported GPU encoder was detected by FFmpeg.";
}

function selectEncoder(settings, capabilities, preferredEncoder = null) {
  if (preferredEncoder) {
    return preferredEncoder;
  }

  const targetCodec = settings.videoCodec || DEFAULT_EXPORT_SETTINGS.videoCodec;
  const softwareEncoder = SOFTWARE_ENCODERS_BY_CODEC[targetCodec] || SOFTWARE_ENCODER;

  if (settings.renderMode === "software") {
    return softwareEncoder;
  }

  const hardwareEncoder = pickHardwareEncoderForCodec(capabilities, targetCodec);
  if (hardwareEncoder) {
    return hardwareEncoder;
  }

  if (settings.renderMode === "force-gpu") {
    const codecLabel = targetCodec === "hevc" ? "H.265" : "H.264";
    throw new Error(
      `Force GPU rendering is enabled, but a usable GPU ${codecLabel} encoder is not available.${buildHardwareAvailabilitySuffix(capabilities, targetCodec)} Switch to Auto GPU or Software render mode, or update the GPU driver/runtime and try again.`,
    );
  }

  return softwareEncoder;
}

function pickHardwareEncoderForCodec(capabilities, targetCodec) {
  const available = Array.isArray(capabilities?.availableHardwareEncoders)
    ? capabilities.availableHardwareEncoders
    : [];
  const codecMatch = available.find((encoder) => (encoder.codec || "h264") === targetCodec);
  if (codecMatch) {
    return codecMatch;
  }
  // Backward compat: when capabilities was generated before the codec field
  // existed, the only detected encoder corresponds to H.264.
  if (targetCodec === "h264" && capabilities?.detectedHardwareEncoder) {
    return capabilities.detectedHardwareEncoder;
  }
  return null;
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
      ...((encoder.name === "h264_nvenc" || encoder.name === "hevc_nvenc") ? ["-preset", "p4"] : []),
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
      ...((encoder.name === "h264_nvenc" || encoder.name === "hevc_nvenc") ? ["-preset", "p4"] : []),
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

  // Normalize A-track audio entries. Independent of the V-track concat —
  // each entry plays at an explicit timelineStart and gets mixed into the
  // final audio bus alongside V-clip audio.
  const audioTrack = Array.isArray(options.audioClips) ? options.audioClips : [];
  const normalizedAudioClips = audioTrack
    .filter((c) => c && c.path && c.hasAudio !== false)
    .map((c, i) => {
      const srcDur = Number(c.sourceDuration || 0);
      const tS = clampNumber(c.trimStart, 0, Math.max(srcDur, 0));
      const tE = clampNumber(
        c.trimEnd,
        Math.min(srcDur, tS + 0.1),
        Math.max(srcDur, tS + 0.1),
      );
      const dur = Number((tE - tS).toFixed(3));
      const ts = Number((Number(c.timelineStart) || 0).toFixed(3));
      if (!Number.isFinite(dur) || dur <= 0) {
        throw new Error(`Audio clip ${i + 1} has no playable duration.`);
      }
      return {
        path: c.path,
        name: c.name || path.basename(c.path),
        trimStart: tS,
        trimEnd: tE,
        duration: dur,
        timelineStart: Math.max(0, ts),
      };
    });

  const normalizedClips = clips.map((clip, index) => {
    // Synthetic black-filler entry — used to bridge gaps between V clips that
    // are no longer edge-to-edge after the user drags. No ffmpeg input is
    // produced; the filter graph generates the stream from lavfi sources.
    if (clip?.isBlackFiller) {
      const dur = Number(((Number(clip.trimEnd) || 0) - (Number(clip.trimStart) || 0)).toFixed(3));
      if (!Number.isFinite(dur) || dur <= 0) {
        throw new Error(`Gap filler ${index + 1} has no playable duration.`);
      }
      return {
        isBlackFiller: true,
        path: null,
        name: clip.name || "(gap)",
        trimStart: 0,
        trimEnd: dur,
        duration: dur,
        hasAudio: false,
        hasVideo: true,
      };
    }
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
    if (!clip.hasVideo && !clip.isBlackFiller) {
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
  // Track each clip's ffmpeg input index (or null for filler entries, which
  // are produced inside the filter graph via lavfi sources and don't add a
  // `-i` argument).
  const clipInputIndex = [];
  let inputIdx = 0;
  normalizedClips.forEach((clip) => {
    if (clip.isBlackFiller) {
      clipInputIndex.push(null);
      return;
    }
    args.push("-ss", formatSeconds(clip.trimStart));
    args.push("-t", formatSeconds(clip.duration));
    args.push("-i", clip.path);
    clipInputIndex.push(inputIdx);
    inputIdx += 1;
  });
  // A-track inputs come after V-clip inputs; we capture the starting input
  // index so the A-clip filter chain references the right `-i`.
  const audioInputBase = inputIdx;
  normalizedAudioClips.forEach((aClip) => {
    args.push("-ss", formatSeconds(aClip.trimStart));
    args.push("-t", formatSeconds(aClip.duration));
    args.push("-i", aClip.path);
    inputIdx += 1;
  });

  const graphSegments = [];
  const concatInputs = [];

  normalizedClips.forEach((clip, index) => {
    if (clip.isBlackFiller) {
      // Black video filler — pure lavfi source matching the output canvas.
      graphSegments.push(
        `color=c=black:s=${settings.width}x${settings.height}:r=${settings.fps}:d=${formatSeconds(clip.duration)},format=yuv420p,setsar=1,setpts=PTS-STARTPTS[v${index}]`,
      );
      // Silence for the same duration.
      graphSegments.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${formatSeconds(clip.duration)},asetpts=PTS-STARTPTS[a${index}]`,
      );
    } else {
      const realIdx = clipInputIndex[index];
      graphSegments.push(
        buildVideoFilterChain({
          inputTag: `[${realIdx}:v]`,
          outputTag: `v${index}`,
          settings,
          videoPipeline,
        }),
      );
      if (clip.hasAudio) {
        graphSegments.push(
          `[${realIdx}:a]aformat=channel_layouts=stereo:sample_rates=48000:sample_fmts=fltp,` +
            `aresample=48000,atrim=duration=${formatSeconds(clip.duration)},asetpts=PTS-STARTPTS[a${index}]`,
        );
      } else {
        graphSegments.push(
          `anullsrc=r=48000:cl=stereo,atrim=duration=${formatSeconds(clip.duration)},asetpts=PTS-STARTPTS[a${index}]`,
        );
      }
    }
    concatInputs.push(`[v${index}]`, `[a${index}]`);
  });

  // V-track concat → [vout] (video) + [vConcatA] (audio bus from embedded V audio)
  const concatAudioOutTag = normalizedAudioClips.length > 0 ? "vConcatA" : "aout";
  graphSegments.push(
    `${concatInputs.join("")}concat=n=${normalizedClips.length}:v=1:a=1[vout][${concatAudioOutTag}]`,
  );

  // Build delayed A-track streams and mix them with the V-track audio bus.
  // A-track inputs come AFTER all real V-clip inputs (fillers don't add
  // inputs), so we offset by `audioInputBase`, not `normalizedClips.length`.
  if (normalizedAudioClips.length > 0) {
    normalizedAudioClips.forEach((aClip, i) => {
      const aInputIdx = audioInputBase + i;
      const delayMs = Math.round(aClip.timelineStart * 1000);
      const delayPart = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
      graphSegments.push(
        `[${aInputIdx}:a]aformat=channel_layouts=stereo:sample_rates=48000:sample_fmts=fltp,` +
          `aresample=48000,atrim=duration=${formatSeconds(aClip.duration)},` +
          `asetpts=PTS-STARTPTS${delayPart}[A${i}]`,
      );
    });
    // amix sums the V audio bus + every A-track delayed stream. normalize=0
    // preserves source loudness; users manage gain via per-clip volume (TBD).
    // dropout_transition=0 stops the gain from rising when shorter streams end.
    const mixInputs = [`[${concatAudioOutTag}]`]
      .concat(normalizedAudioClips.map((_, i) => `[A${i}]`))
      .join("");
    graphSegments.push(
      `${mixInputs}amix=inputs=${normalizedAudioClips.length + 1}:duration=longest:dropout_transition=0:normalize=0[aout]`,
    );
  }

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

function summarizeExportSettings({ clips, audioClips, settings, ffmpegPath }) {
  return getRenderCapabilities(ffmpegPath).then((capabilities) => {
    const plan = buildExportPlan(clips, settings, { capabilities, audioClips });
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

async function runExport({ clips, audioClips, outputPath, settings, ffmpegPath, onProgress }) {
  if (!outputPath) {
    throw new Error("Choose an export destination before rendering.");
  }

  const capabilities = await getRenderCapabilities(ffmpegPath);
  const preferredPlan = buildExportPlan(clips, settings, { capabilities, audioClips });

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
        audioClips,
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

async function preparePreviewMedia({ inputPath, ffmpegPath, ffprobePath, cacheDir }) {
  if (!inputPath) {
    throw new Error("Choose a source clip before preparing a preview.");
  }

  await fs.promises.mkdir(cacheDir, { recursive: true });
  const stats = await fs.promises.stat(inputPath);
  // Cache key includes the proxy-codec version so a code change forces a
  // regeneration instead of reusing a stale (slow / large) old proxy. Bumped
  // to v4 because resolution was raised from 1024 to 1440 for sharper preview.
  const PROXY_CODEC_VERSION = "v4-ultrafast-1440p-safe";
  const cacheKey = crypto
    .createHash("sha1")
    .update(`${inputPath}:${stats.size}:${stats.mtimeMs}:${PROXY_CODEC_VERSION}`)
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

  // Probe the source duration up front so we can verify the proxy isn't
  // truncated after ffmpeg returns. Truncated proxies have been the recurring
  // bug: a multi-hour source ends up cached as a 3-minute file because some
  // earlier ffmpeg flag caused it to bail silently.
  let sourceDurationSeconds = 0;
  if (ffprobePath) {
    try {
      const probe = await probeMedia(inputPath, ffprobePath);
      sourceDurationSeconds = Number(probe.duration) || 0;
    } catch {
      // Couldn't probe — skip verification rather than fail the proxy entirely.
    }
  }

  // Write to a .tmp file and atomically rename on success — that way a crash
  // or interrupted run never leaves a partial proxy in the cache that would
  // later be served as if complete (showing only the first few minutes of a
  // long video, which is exactly the symptom users hit).
  const tempPath = `${outputPath}.tmp`;
  try {
    await fs.promises.unlink(tempPath);
  } catch {
    // No stale tmp, fine.
  }

  try {
    await new Promise((resolve, reject) => {
      // Proxy strategy: downscale aggressively (max 1024px on the long edge),
      // ultrafast preset, tune for fast decode, and force tight ~1s GOPs so
      // the <video> element can seek instantly. The second scale pass
      // guarantees even dimensions for x264. +genpts and avoid_negative_ts
      // make the proxy robust against sources with sketchy timestamps that
      // would otherwise cause ffmpeg to bail or produce un-seekable output.
      // We DO NOT pass -vsync vfr / +igndts / -err_detect ignore_err here —
      // those triggered silent mid-stream stops that produced truncated
      // proxies on long recordings.
      const ffmpeg = spawn(
        ffmpegPath,
        [
          "-y",
          "-fflags",
          "+genpts",
          "-i",
          inputPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-vf",
          "scale=1440:1440:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=fast_bilinear,format=yuv420p",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "fastdecode",
          "-crf",
          "28",
          "-g",
          "30",
          "-keyint_min",
          "30",
          "-sc_threshold",
          "0",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-ac",
          "2",
          "-avoid_negative_ts",
          "make_zero",
          "-movflags",
          "+faststart",
          "-threads",
          "0",
          tempPath,
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

    // Post-generation duration check: if the proxy is materially shorter than
    // the source, reject it instead of caching a broken file. The user's
    // symptom — "1.5 hr source, monitor shows 3 minutes" — is exactly this.
    if (ffprobePath && sourceDurationSeconds > 5) {
      try {
        const proxyProbe = await probeMedia(tempPath, ffprobePath);
        const proxyDuration = Number(proxyProbe.duration) || 0;
        const minAcceptable = sourceDurationSeconds * 0.9;
        if (proxyDuration < minAcceptable) {
          throw new Error(
            `Preview proxy looked truncated (${proxyDuration.toFixed(1)}s out of ${sourceDurationSeconds.toFixed(1)}s) and was rejected.`,
          );
        }
      } catch (probeError) {
        // If the message we synthesized above bubbled up, surface it as-is.
        if (probeError && probeError.message && probeError.message.includes("truncated")) {
          throw probeError;
        }
        // Otherwise the probe itself failed; treat as opaque proxy issue.
      }
    }

    await fs.promises.rename(tempPath, outputPath);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }

  return outputPath;
}

// FFmpeg codec + extension matrix for audio-only export. WAV is uncompressed
// PCM so bitrate is ignored; AAC + MP3 honor the user's bitrate selection.
const AUDIO_EXPORT_FORMATS = Object.freeze({
  m4a: { codec: "aac", label: "AAC audio", honorsBitrate: true },
  mp3: { codec: "libmp3lame", label: "MP3 audio", honorsBitrate: true },
  wav: { codec: "pcm_s16le", label: "WAV / PCM audio", honorsBitrate: false },
});

function resolveAudioExportFormat(audioFormat) {
  const key = String(audioFormat || "m4a").toLowerCase();
  return AUDIO_EXPORT_FORMATS[key] ? key : "m4a";
}

// Audio-only export: concatenate the audio portion of each timeline clip
// (respecting trims and the per-clip mute / detach-audio toggle) into a
// single audio file. Independent of the video export pipeline so it stays
// simple and fast.
const SUPPORTED_AUDIO_SAMPLE_RATES = Object.freeze([22050, 32000, 44100, 48000, 96000]);

function normalizeSampleRate(value) {
  const numeric = Number.parseInt(value, 10);
  return SUPPORTED_AUDIO_SAMPLE_RATES.includes(numeric) ? numeric : 48000;
}

async function runAudioExport({ clips, audioClips, outputPath, audioFormat, audioBitrate, sampleRate, ffmpegPath, onProgress }) {
  if (!outputPath) {
    throw new Error("Choose an export destination before rendering audio.");
  }
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("Add at least one clip to the sequence before exporting audio.");
  }

  const formatKey = resolveAudioExportFormat(audioFormat);
  const formatInfo = AUDIO_EXPORT_FORMATS[formatKey];
  const bitrate = normalizeAudioBitrate(audioBitrate);
  const sr = normalizeSampleRate(sampleRate);
  const aTrack = Array.isArray(audioClips) ? audioClips.filter((c) => c && c.path) : [];

  const inputArgs = [];
  const filterParts = [];
  const concatInputs = [];
  // Explicit input-index counter — the old code computed it from
  // inputArgs.length/2-1 which breaks when lavfi adds extra flags (6 args
  // instead of 2 for one input).
  let inputIdx = 0;

  clips.forEach((clip, i) => {
    // Filler entries from the renderer's V-gap insertion: pure silence for
    // the gap duration; no source path needed.
    if (clip?.isBlackFiller) {
      const dur = Math.max(0.001, (Number(clip.trimEnd) || 0) - (Number(clip.trimStart) || 0));
      inputArgs.push(
        "-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      );
      filterParts.push(`[${inputIdx}:a]asetpts=PTS-STARTPTS[a${i}]`);
      concatInputs.push(`[a${i}]`);
      inputIdx += 1;
      return;
    }
    if (!clip?.path) {
      throw new Error(`Clip ${i + 1} is missing a file path.`);
    }
    const trimStart = Number(clip.trimStart) || 0;
    const trimEnd = Number(clip.trimEnd) || (Number(clip.sourceDuration) || 0);
    const duration = Math.max(0.001, trimEnd - trimStart);
    if (clip.hasAudio) {
      inputArgs.push("-i", clip.path);
      filterParts.push(
        `[${inputIdx}:a]atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[a${i}]`,
      );
    } else {
      // lavfi-generated silence for muted / silent V clips so the concat keeps
      // the right total runtime.
      inputArgs.push(
        "-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      );
      filterParts.push(`[${inputIdx}:a]asetpts=PTS-STARTPTS[a${i}]`);
    }
    concatInputs.push(`[a${i}]`);
    inputIdx += 1;
  });

  // V-track audio concat → either final output or mixed with A-track audios.
  const concatOutTag = aTrack.length > 0 ? "vConcatA" : "outa";
  filterParts.push(
    `${concatInputs.join("")}concat=n=${clips.length}:v=0:a=1[${concatOutTag}]`,
  );

  // A-track audio clips: add inputs + delay each to its timelineStart.
  if (aTrack.length > 0) {
    aTrack.forEach((aClip, j) => {
      const tS = Number(aClip.trimStart) || 0;
      const tE = Number(aClip.trimEnd) || (Number(aClip.sourceDuration) || 0);
      const dur = Math.max(0.001, tE - tS).toFixed(3);
      inputArgs.push("-ss", tS.toFixed(3), "-t", dur, "-i", aClip.path);
      const delayMs = Math.round(Math.max(0, Number(aClip.timelineStart) || 0) * 1000);
      const delayPart = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
      filterParts.push(
        `[${inputIdx}:a]aformat=channel_layouts=stereo:sample_rates=48000:sample_fmts=fltp,` +
          `aresample=48000,asetpts=PTS-STARTPTS${delayPart}[A${j}]`,
      );
      inputIdx += 1;
    });
    const mixInputs = [`[${concatOutTag}]`].concat(aTrack.map((_, j) => `[A${j}]`)).join("");
    filterParts.push(
      `${mixInputs}amix=inputs=${aTrack.length + 1}:duration=longest:dropout_transition=0:normalize=0[outa]`,
    );
  }

  const filterComplex = filterParts.join(";");
  const vDuration = clips.reduce(
    (sum, c) => sum + Math.max(0, (Number(c.trimEnd) || 0) - (Number(c.trimStart) || 0)),
    0,
  );
  const aTrackEnd = aTrack.reduce((max, c) => {
    const ts = Number(c.timelineStart) || 0;
    const tE = Number(c.trimEnd) || 0;
    const tS = Number(c.trimStart) || 0;
    return Math.max(max, ts + Math.max(0, tE - tS));
  }, 0);
  const totalDuration = Math.max(vDuration, aTrackEnd);

  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outa]",
    "-c:a",
    formatInfo.codec,
  ];
  if (formatInfo.honorsBitrate) {
    args.push("-b:a", bitrate);
  }
  args.push("-ar", String(sr), "-ac", "2");
  // MP4/M4A containers benefit from faststart; MP3/WAV ignore the flag without
  // erroring, but we omit it to keep the command minimal for non-MP4 outputs.
  if (formatKey === "m4a") {
    args.push("-movflags", "+faststart");
  }
  args.push(outputPath);

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof onProgress === "function") {
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
        if (m) {
          const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          onProgress({
            percent: totalDuration > 0 ? Math.min(99, (seconds / totalDuration) * 100) : 0,
            status: "rendering",
            currentTimeSeconds: seconds,
            totalDuration,
            encoderLabel: formatInfo.label,
            pipelineLabel: `Audio export (${formatKey.toUpperCase()})`,
          });
        }
      }
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`Unable to export audio: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  const stats = await fs.promises.stat(outputPath);
  if (typeof onProgress === "function") {
    onProgress({
      percent: 100,
      status: "done",
      currentTimeSeconds: totalDuration,
      totalDuration,
      encoderLabel: formatInfo.label,
      pipelineLabel: `Audio export (${formatKey.toUpperCase()})`,
    });
  }
  return {
    outputPath,
    outputSizeBytes: stats.size,
    outputSizeLabel: humanFileSize(stats.size),
    clipCount: clips.length,
    totalDuration,
    encoderLabel: formatInfo.label,
    pipelineLabel: `Audio export (${formatKey.toUpperCase()})`,
  };
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
  runAudioExport,
  summarizeExportSettings,
};
