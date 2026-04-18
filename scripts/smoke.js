const path = require("path");
const { buildExportPlan } = require("../src/exporter");

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
  videoEncoder: "libx264",
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

if (!Number.isFinite(plan.estimatedFileSizeBytes) || plan.estimatedFileSizeBytes <= 0) {
  throw new Error("Expected estimated output size to be calculated.");
}

const bitratePlan = buildExportPlan(clips, {
  width: 1920,
  height: 1080,
  fps: 30,
  videoBitrate: "20000k",
  videoEncoder: "libx264",
});

if (!bitratePlan.args.includes("-b:v")) {
  throw new Error("Expected manual bitrate export arguments to be generated.");
}

console.log("Smoke test passed.");
