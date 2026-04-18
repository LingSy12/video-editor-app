# Cutline Studio

Cutline Studio is a Windows desktop MVP for combining multiple source videos into one final video. It gives you a Premiere-style workspace with:

- Media bin for imported video files
- Sequence timeline list with ordering controls
- Millisecond trim and split-at-playhead editing
- Timeline scrub preview with proxy playback
- MP4 export with FFmpeg, GPU-preferred rendering, and bitrate presets

## Requirements

- Node.js installed

The app bundles FFmpeg binaries through npm packages, so you do not need a system `ffmpeg` install.

## Run

```bash
npm install
npm start
```

## Build EXE

```bash
npm run pack:win
```

The portable Windows executable is written to `dist/<version>/Cutline Studio-<version>-portable.exe`.

Each packaged version is kept in its own folder under `dist/<version>/`, so builds like
`Cutline Studio-1.0.0-portable.exe` and `Cutline Studio-1.0.1-portable.exe` can coexist.
The intermediate `win-unpacked` folder is removed automatically after packaging finishes.

## Features

- Import multiple clips
- Automatically add newly imported clips to the sequence
- Double-click clips to add extra copies to the sequence
- Reorder clips in the sequence
- Trim each clip by milliseconds
- Split the selected sequence clip at the current playhead
- Scrub and play the full timeline across clip boundaries in the program monitor
- Export the whole sequence as one MP4 with auto GPU preference or software fallback
- Choose higher export bitrates and see estimated file size / render ETA during export
- Automatically generate silent audio for clips that do not contain audio
- Automatically generate compatible preview proxies for smoother playback

## Notes

- This is an MVP, not a full Adobe Premiere replacement.
- Export re-encodes clips to a consistent resolution and frame rate for reliable stitching.
- Timeline preview is proxy-assisted for smoother playback and better codec compatibility.
- The current packaged build is an unsigned portable `.exe` and uses Electron's default app icon.
