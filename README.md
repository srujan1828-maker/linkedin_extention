# LinkedIn Learning AI AutoPilot

A Manifest V3 browser extension for LinkedIn Learning playback controls, lesson navigation, and optional AI assistance. Version **10.8.0**.

## Installation

1. Download the **master** branch and extract the ZIP.
2. Open `chrome://extensions/` in Chrome, Edge, or Brave and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted extension folder.
4. Open a LinkedIn Learning course. After updating an existing installation, reload the extension and refresh all LinkedIn tabs so both scripts update together.

## Controls

- **Speed injection:** apply a saved playback speed, bounded to 0.25–16×. Disabling it resets the rate to 1× and returns control to the native player. Actual support and audible sound at extreme speeds depend on the browser.
- **Background play:** enable visibility handling for background playback. Disabling it restores native visibility reporting. Browser suspension, autoplay restrictions, and OS power saving can still pause a tab.
- **Auto-navigation:** allow automatic movement between lessons. Turning it off prevents automatic lesson navigation; manual next-lesson controls remain available.
- **AutoPilot:** start the bulk course workflow in the selected focus mode. Stop cancels pending lesson navigation and clears the saved bulk state. Changing speed alone preserves pause, mute, and pitch preferences.
- **AI providers:** optionally configure Gemini, Groq, OpenRouter, or NVIDIA credentials in the popup. Identical in-flight prompts share a request; different prompts receive independent responses.

Saved settings load before player observation and update across open tabs. The extension preserves real playback rates, including speeds below 1×, and attaches to replacement videos during page navigation.

## Running learning paths

Open **LinkedIn Learning → My Content → In progress** (or Recommended / Assigned) and click **Run All Paths in My Content** in the popup. It expands the list's **Show more** buttons, collects path headings, and saves a queue for the paths in that list. Switch library sections and run again to process paths in another section. Enable Auto-navigation first.

The queue uses pending-only mode. It opens each path's unfinished items in order, preserves the path and organization URL context, and returns to the overview after each course or standalone video. Standalone items play only their linked video. A path advances only after all its item cards show LinkedIn's explicit **Completed** status. The queue persists across page loads; Stop cancels it and pending quiz actions.

For quizzes, enable AI assistance and configure a provider key. The solver reads the active chapter question, validates exact option text / zero-based indices, clicks each native input once, verifies selection, and submits only through an enabled button. Missing keys, API failures, invalid answers, or failed selection pause the run. A generic results heading or another completed quiz cannot verify the current quiz. AI correctness remains dependent on the provider.

Summative final exams require manual completion. If one remains after course lessons, the run pauses and tells you to complete it before restarting. The queue covers paths listed in the selected library section, not every path in LinkedIn's catalog.

## Privacy and limitations

Settings and API keys are stored in local browser extension storage. When AI assistance is used, the constructed question prompt and course context are sent to the configured external AI provider. Review the provider's data handling policy before use. Local extension storage is not a dedicated encrypted credential vault.

LinkedIn completion indicators and navigation depend on the current page markup. AI answers can be wrong, and this extension cannot guarantee a completion badge or certificate. It does not directly edit LinkedIn progress through an API. Follow applicable course and assessment rules.

The scripts currently match LinkedIn pages broadly to support the existing course/path navigation workflow. Only run AutoPilot on the learning workflow you intend to control.

## Verification

Run with Node.js 18 or later, without installing dependencies:

```sh
node --test tests/regression.test.cjs
node --check content.js
node --check page-inject.js
node --check background.js
node --check popup.js
```

The regression tests use mocked browser and extension APIs. They cover settings, playback preferences, Stop cancellation, AI request isolation, active-question parsing, invalid-answer rejection, single-click input selection, path card extraction, context preservation, and queue progress. The current path, sidebar, standalone-player, library-pagination, and chapter-quiz markup were inspected in signed-in LinkedIn Learning. Full path completion and live AI submissions have not been tested end to end.
