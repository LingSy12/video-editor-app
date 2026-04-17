# Cutline Studio

Cutline Studio is a Windows desktop MVP for combining multiple source videos into one final video. It gives you a Premiere-style workspace with:

- Media bin for imported video files
- Sequence timeline list with ordering controls
- Clip trim in and out points
- Program monitor preview
- MP4 export with FFmpeg

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

The portable Windows executable is written to `dist/Cutline Studio-<version>-portable.exe`.

## Features

- Import multiple clips
- Automatically add newly imported clips to the sequence
- Double-click clips to add extra copies to the sequence
- Reorder clips in the sequence
- Trim each clip by seconds
- Export the whole sequence as one MP4
- Automatically generate silent audio for clips that do not contain audio
- Automatically generate a compatible preview proxy when a source clip cannot preview directly

## Notes

- This is an MVP, not a full Adobe Premiere replacement.
- Export re-encodes clips to a consistent resolution and frame rate for reliable stitching.
- The current packaged build is an unsigned portable `.exe` and uses Electron's default app icon.
