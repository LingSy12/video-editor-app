const path = require("path");
const { buildExportPlan, parseEncoderList } = require("../src/exporter");

const clips = [
  {
    path: path.join("C:", "media", "intro.mp4"),
    name: "intro.mp4",
    trimStart: 0,
    trimEnd: 4.5,
    sourceDuration: 4.5,
    hasAudio: true,
    hasVideo: true,
  },
  {
    path: path.join("C:", "media", "silent-broll.mov"),
    name: "silent-broll.mov",
    trimStart: 1,
    trimEnd: 6.2,
    sourceDuration: 8.1,
    hasAudio: false,
    hasVideo: true,
  },
];

const plan = buildExportPlan(clips, {
  width: 1280,
  height: 720,
  fps: 30,
  crf: 21,
  videoPreset: "fast",
  renderMode: "software",
});

if (plan.clips.length !== 2) {
  throw new Error("Expected two normalized clips.");
}

if (!plan.args.includes("-filter_complex")) {
  throw new Error("Expected ffmpeg filter graph to be generated.");
}

if (!plan.args.join(" ").includes("anullsrc")) {
  throw new Error("Expected silent clips to receive generated audio.");
}

if (plan.encoder.name !== "libx264") {
  throw new Error("Expected the smoke test plan to fall back to software x264 by default.");
}

if (!Number.isFinite(plan.resolvedVideoBitrateKbps) || plan.resolvedVideoBitrateKbps <= 0) {
  throw new Error("Expected a resolved video bitrate estimate.");
}

const parsedEncoders = parseEncoderList(`
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
`);

if (!parsedEncoders.has("h264_nvenc")) {
  throw new Error("Expected FFmpeg encoder parsing to include NVENC entries flagged with D.");
}

const autoGpuFallbackPlan = buildExportPlan(
  clips,
  {
    width: 1280,
    height: 720,
    fps: 30,
    crf: 21,
    videoPreset: "fast",
    renderMode: "auto-gpu",
  },
  {
    capabilities: {
      detectedHardwareEncoder: null,
      availableHardwareEncoders: [],
      unusableHardwareEncoders: [
        {
          label: "Intel Quick Sync H.264",
          probeError: "The current mfx implementation is not supported",
        },
      ],
    },
  },
);

if (autoGpuFallbackPlan.encoder.name !== "libx264") {
  throw new Error("Expected Auto GPU to fall back to software when hardware probes fail.");
}

const gpuPlan = buildExportPlan(
  clips,
  {
    width: 1280,
    height: 720,
    fps: 30,
    crf: 21,
    videoPreset: "fast",
    renderMode: "force-gpu",
  },
  {
    capabilities: {
      detectedHardwareEncoder: {
        name: "h264_nvenc",
        label: "NVIDIA NVENC H.264",
        type: "hardware",
        vendor: "nvidia",
      },
      availableHardwareEncoders: [
        {
          name: "h264_nvenc",
          label: "NVIDIA NVENC H.264",
          type: "hardware",
          vendor: "nvidia",
        },
      ],
      availableVideoPipelines: [
        {
          name: "cuda-scale",
          label: "CUDA scaling",
          vendor: "nvidia",
        },
      ],
      detectedVideoPipeline: {
        name: "cuda-scale",
        label: "CUDA scaling",
        vendor: "nvidia",
      },
    },
  },
);

if (!gpuPlan.args.join(" ").includes("scale_cuda")) {
  throw new Error("Expected NVIDIA GPU plans to use CUDA scaling when the runtime probe succeeds.");
}

if (gpuPlan.pipelineLabel !== "NVIDIA NVENC H.264 + CUDA scaling") {
  throw new Error("Expected GPU plans to expose a combined pipeline label.");
}

let forceGpuError = null;
try {
  buildExportPlan(
    clips,
    {
      width: 1280,
      height: 720,
      fps: 30,
      crf: 21,
      videoPreset: "fast",
      renderMode: "force-gpu",
    },
    {
      capabilities: {
        detectedHardwareEncoder: null,
        availableHardwareEncoders: [],
        unusableHardwareEncoders: [
          {
            label: "Intel Quick Sync H.264",
            probeError: "The current mfx implementation is not supported",
          },
        ],
      },
    },
  );
} catch (error) {
  forceGpuError = error;
}

if (!forceGpuError || !forceGpuError.message.includes("Intel Quick Sync H.264")) {
  throw new Error("Expected Force GPU errors to explain which hardware encoder probe failed.");
}

console.log("Smoke test passed.");
