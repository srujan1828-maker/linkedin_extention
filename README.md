<div align="center">
  <h1>⚡ LinkedIn Learning — Speed & Autoplay</h1>
  <p><strong>A clean, open-source browser extension that lets you watch LinkedIn Learning videos at up to 16x speed and automatically advances to the next lesson when a video ends.</strong></p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/platform-LinkedIn%20Learning-0a66c2.svg" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License">
</p>

## ✨ Features

| Feature | Detail |
|---|---|
| 🚀 **Speed Control** | 13 presets from **0.5x → 16x** via preset buttons or a smooth slider |
| ⏭ **Auto-play Next Lesson** | When a video ends, the extension automatically clicks the "Next" button |
| 🔁 **Manual Next** | One-click "Go to Next Lesson Now" button in the popup |
| 🛡 **Anti-reset Defense** | Counters LinkedIn's player resetting your speed on seek/source-swap |
| 💾 **Persistent Settings** | Your chosen speed and autoplay preference survive browser restarts |
| 🔒 **Privacy-safe** | All data stays in your browser. Zero external servers. |

## 🛠 Installation

1. Download and extract this folder.
2. Open `chrome://extensions/` in Chrome / Edge / Brave.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Navigate to any `linkedin.com/learning/` course and click the extension icon.

## 🎛 How to Use

- **Speed presets**: Click any of the 13 speed buttons (0.5x, 0.75x, 1x … 16x).
- **Slider**: Drag the slider for fine-grained control.
- **Auto-advance toggle**: Click the ON/OFF toggle. When **ON**, the extension clicks "Next Lesson" automatically when a video finishes.
- **Next Lesson button**: Jump to the next lesson manually at any time.

> **Note**: Speeds above 2x are not available in LinkedIn's native player UI — this extension bypasses that restriction directly via the HTML5 `video.playbackRate` property.

## 🔐 Permissions

| Permission | Why |
|---|---|
| `storage` | Save your speed and autoplay settings |
| `tabs` | Detect which tab is on LinkedIn Learning |
| `activeTab` | Send messages to the active tab's content script |
| `https://www.linkedin.com/learning/*` | Only runs on LinkedIn Learning pages |

## ⚖ Disclaimer

This extension does not mark lessons as complete, manipulate progress, or make any API calls. It only controls the HTML5 video player in your browser. Use responsibly.
