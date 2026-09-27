# Jarvis Desktop

> AI-powered desktop assistant — voice dictation, transcription, and contextual nudges.

[![Build Windows](https://github.com/YOUR_ORG/jarvis-desktop/actions/workflows/build-windows.yml/badge.svg)](../../actions/workflows/build-windows.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

Jarvis is a cross-platform Electron desktop app that provides:

- **Push-to-talk dictation** with local Whisper / Sherpa-ONNX transcription
- **Global hotkeys** (including Fn key on macOS) for instant activation
- **Context-aware nudges** based on the frontmost application
- **Menu bar / system tray** integration with quick actions
- **Local-only by default** — no audio leaves your machine unless you opt in

## Features

| Feature | Status |
|---|---|
| Local Whisper transcription | ✅ |
| Sherpa-ONNX streaming ASR | ✅ |
| Global push-to-talk (macOS Fn / Windows) | ✅ |
| Auto-paste into frontmost app | ✅ |
| Analysis overlay | ✅ |
| Auto-update via GitHub Releases | ✅ |
| Code-signed & notarized macOS builds | ✅ |
| Code-signed Windows builds | ✅ |

## Requirements

- **Node.js** ≥ 18 (20 LTS recommended)
- **npm** ≥ 9
- **Platform toolchain:**
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Visual Studio 2022 Build Tools (C++ workload) + Python 3.11
  - Linux: `build-essential`, `python3`, `libsecret-1-dev`

## Quick start

```bash
# 1. Clone
git clone https://github.com/YOUR_ORG/jarvis-desktop.git
cd jarvis-desktop

# 2. Install (uses lockfile — reproducible)
npm ci

# 3. Rebuild native modules for Electron's ABI
npx electron-rebuild -f

# 4. Development (hot reload for renderer)
npm run dev

# 5. Production build
NODE_ENV=production npm run build
