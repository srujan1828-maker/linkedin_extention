# LinkedIn Learning AI AutoPilot

A Manifest V3 browser extension for LinkedIn Learning playback controls, lesson navigation, and optional AI assistance. Version **10.8.18**.

## Installation

1. Download the **master** branch and extract the ZIP.
2. Open `chrome://extensions/` in Chrome, Edge, or Brave and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted extension folder.
4. Open a LinkedIn Learning course. After updating an existing installation, reload the extension and refresh all LinkedIn tabs so both scripts update together.

## Controls

- **Speed injection:** apply a saved playback speed, bounded to 0.25–16×. Disabling it resets the rate to 1× and returns control to the native player. Actual support and audible sound at extreme speeds depend on the browser.
- **Background play:** supervise playback after tab switches, including ordinary autoplay and replacement players. Ctrl+Tab and unrelated page clicks do not cancel recovery. Actual playback controls and Space/K pause intentionally; press Play or restart AutoPilot to continue. Browser autoplay rejection uses a muted retry and reports if playback still cannot start. Stop cancels automatic playback. Chrome must remain open and the computer awake; a suspended browser or sleeping computer cannot keep playing.
- **Auto-navigation:** allow automatic movement between lessons. Turning it off prevents automatic lesson navigation; manual next-lesson controls remain available.
- **AutoPilot:** start the bulk course workflow in the selected focus mode. Stop cancels pending lesson navigation and clears the saved bulk state. Changing speed alone preserves pause, mute, and pitch preferences. Player surveys are skipped during AutoPilot and ordinary autoplay when auto-navigation and non-video skipping are enabled. Stop pauses automatic survey skipping until automation is restarted. The extension clicks Skip survey without choosing a rating; generic Close/Skip controls are used only inside a matching survey context.
- **AI providers:** optionally configure Gemini, Groq, OpenRouter, or NVIDIA credentials in the popup. Identical in-flight prompts share a request; different prompts receive independent responses.

Saved settings load before player observation and update across open tabs. The extension preserves real playback rates, including speeds below 1×, and attaches to replacement videos during page navigation.

## Running learning paths

Click **Run All Paths in My Content** from a LinkedIn Learning page. It opens My Content when needed, follows the available In progress / Saved / Assigned / Recommended section links, expands Show more, deduplicates learning paths and starts a persistent queue. Discovery is isolated from the course runner so it cannot escape My Content while collecting paths. Enable Auto-navigation first.

The queue uses pending-only mode. It opens each path's unfinished items in order, preserves the path and organization URL context, and returns to the overview after each course or standalone video. Standalone items play only their linked video. A path advances only after all its item cards show LinkedIn's explicit **Completed** status. The queue persists across page loads; Stop cancels it and pending quiz actions while preserving your AI-assistance preference. Ordinary autoplay also returns to the remembered path after the last lesson. Return navigation uses the saved queue, a valid back-link URL even in a hidden sidebar, saved path state, or a same-site path referrer.

For quizzes, enable AI assistance and configure a provider key. The solver detects chapter quizzes that mount after navigation, prioritizes active questions over Viewed markers, and prevents non-video navigation from skipping a loading quiz. One workflow runs at a time through verification and retakes. A provider-key change or re-enabling AI assistance clears a paused error; Solve Current Quiz reports failures in the Activity Log. Completed chapter practice results such as “You answered 2 of 4 questions” / “Keep practicing” are recognized even outside the legacy quiz container and with retained review controls. The current quiz's completion marker is checked before review/retry or question parsing, keeping AutoPilot running. A partial score without verified completion still does not authorize advancement. After verified completion, it explicitly advances to the next unfinished course item (or returns to the path), including during ordinary autoplay. It treats the verified quiz as completed locally while waiting for the sidebar marker to update, and does not require a page refresh. The solver reads the active chapter question, validates exact option text / zero-based indices, clicks each native input once, verifies selection, and submits only through an enabled button. Missing keys, API failures, invalid answers, or failed selection pause the run. A generic results heading or another completed quiz cannot verify the current quiz. AI correctness remains dependent on the provider.

Summative final exams require manual completion. After course lessons finish, the extension returns to the path first. If the path still shows that course as unfinished and it has a final exam, the run pauses there and tells you to check the exam before restarting. The queue covers paths listed in the available My Content sections, not every path in LinkedIn's catalog.

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

The regression tests use mocked browser and extension APIs, including a complete single-question chapter-quiz flow from provider response through native selection, submission and verification. They cover settings, playback preferences, Stop cancellation, AI request isolation, active-question parsing, invalid-answer rejection, single-click input selection, path card extraction, context preservation, and queue progress. The current path, sidebar, standalone-player, library-pagination, and chapter-quiz markup were inspected in signed-in LinkedIn Learning. Full path completion and live AI submissions have not been tested end to end.

### Background reliability (10.8.8)

With Background Tab Playback enabled, active runs register with a service-worker supervisor. Chrome alarms nudge the page every 30 seconds, and active learning tabs are protected from automatic memory discard. Registrations survive service-worker restarts. Stop, disabling background playback, finishing the run, or leaving Learning releases protection and restores the original tab setting. Transient page loads get a reconnect grace period; abandoned registrations expire.

Routine HUD updates are suppressed during background AutoPilot runs, repeated identical progress reports are coalesced, and the always-open keepalive ping connection is replaced by alarm supervision. Errors and completion reports remain immediate. This requires Chrome 120 or later and adds the alarms permission. Keep Chrome, the learning tab and the computer running; alarms do not make a frozen page execute and cannot work while the computer sleeps. The page still performs playback and course navigation; this does not mark content complete through private APIs.

### Passive completion monitoring (10.8.8)

The extension observes existing LinkedIn fetch/XHR responses for video progress and quiz status. It binds content identities from metadata responses to the exact lesson route, then accepts successful completion responses only for that identity. Completion evidence supplements delayed sidebar markers and nudges the existing runner. Errors, application errors, unknown content, expired evidence, prior lessons and responses preceding a new run cannot mark the current item complete. Reset/IN_PROGRESS responses invalidate completion evidence; Stop clears it and cancels delayed continuation.

The bridge sends only item kind, status, route and timestamps. Request headers, cookies, quiz answers and HAR files are not stored or sent to the extension. No private endpoint is replayed; failed progress writes are logged rather than automatically resubmitted. LinkedIn's next-incomplete-item request returned 204 in the capture, which does not establish a navigation destination, so existing page navigation remains authoritative. DOM checks remain the fallback if private response formats change.

### Playback and navigation recovery (v10.8.9)

AutoPilot waits for a missing player instead of skipping its lesson. If a video makes no progress for 60 seconds, it reloads the current page while retaining the saved run state. LinkedIn's Oops screen gets up to three Try again clicks, spaced 15 seconds apart. A per-route session budget permits two reloads in ten minutes before pausing with a visible error; real playback progress clears that budget. Active quiz questions and normal path overviews are excluded from video stall reloads.

Single-question quiz results and Continue watching are recognized. Continuation attempts can run again if the page did not transition, and the runner chooses the earliest unfinished syllabus item to catch gaps.

### Background player handoff (v10.8.10)

The page engine tracks play/playing events, resets recovery attempts after playback resumes, and can resume replacement video players on canplay while background automation is enabled. Trusted user pauses are preserved. Background supervision stays registered between lessons while autoplay and automatic navigation are enabled, rather than releasing protection when the preceding video ends. Stop disables the automation playback bridge.

### Resume after recovery reload (v10.8.11)

Recovery reloads finish saving the active AutoPilot, autoplay, and background settings first. Restored runs try playback immediately when ready and on loadeddata/canplay, using serialized play attempts with a two-second cooldown. NotAllowedError retries once with muted playback; a notice explains the change and the next trusted pointer or keyboard interaction restores the original mute setting. A failed muted attempt restores the original setting and asks for a manual Play click. Stop or navigation cancels any later fallback attempt.

### Background watchdog reliability (v10.8.12)

Each service-worker pulse waits at most eight seconds for a tab response so an unresponsive tab cannot block all future supervision. Existing alarm schedules are preserved across page updates; missing alarms are recreated. Content registration renews once per minute. A pulse also nudges the page-world recovery handler when a readiness event was missed.

During AutoPilot, paused video playback is retried before checking autonomous workflow locks, while quiz pages remain excluded. The pulse replies before running recovery so a failing watchdog does not prevent the service worker receiving its status. This does not enable execution while Chrome or the computer is asleep.

### Unfinished quiz reconciliation (v10.8.13)

Video recovery is blocked on quiz and path overview pages in the content script; the page engine also rejects quiz/path routes and cancels queued play attempts after navigation. AutoPilot checks the syllabus every five seconds while a video is playing and returns to earlier unfinished items in the selected focus mode, retaining an active quiz question in place. If the page changes during quiz work, that old work is cancelled before processing the new route.

Bulk playback speed is enforced by the watchdog even during workflow waits. Service-worker pulses resend playback settings to repair a missed page bridge message. Browser background throttling or suspension still limits execution; keep Chrome open and the computer awake.

### Reliability audit (v10.8.14)

Completion detection honors explicit false markers, strips lesson titles from status text, rejects negative statuses, and distinguishes checked-circle icons from unchecked boxes. Ambiguous assessment responses with multiple status records defer to the visible completion status.

AI extension message callbacks have a two-minute timeout and surface Chrome message errors. Updating/reloading the extension stops the old content context, removes its observer and timers, and asks for a LinkedIn tab refresh rather than continuing with an invalid context. Stop events received through storage cancel background work; popup Stop also clears path discovery when a tab cannot reply. Provider selection changes clear stale provider errors.

Pending navigation can recover by elapsed time on a watchdog pulse, and obsolete navigation/skip timers cannot override a new route or skip a quiz/loading video. Path-queue advancement checks the run epoch across asynchronous storage operations and rejects invalid path URLs. Popup commands are limited to LinkedIn Learning origins/routes, and HUD messages render as text.

GitHub Actions checks JavaScript syntax and runs the complete Node regression suite for pull requests and master updates. These checks use browser API fixtures; an authenticated live Chrome playback session is still needed to verify LinkedIn behavior.

### AI option mapping (v10.8.15)

Answer text matching normalizes smart quotes and nonbreaking whitespace while preserving mathematical operators and negation. JSON responses normalize numeric string indices (still zero-based) and explicit scalar/snake-case answer fields.

If an identifiable selection has a mismatched text format, the extension requests at most one format-only repair. The repair must retain the original selected indices. Conflicting indices/text, out-of-range indices, ambiguous or partial text-only answers, and explicit empty/error responses are rejected. Stop or route changes cancel the repair; the solver still rechecks the live question and options before submitting.

### External reading items

Link/article/document items use their own completion UI instead of a video player. With AutoPilot running in all/pending mode and non-video handling enabled, the extension clicks Mark as complete, confirms the article dialog, waits for LinkedIn’s Completed status, and returns to the path to continue. Outside AutoPilot, the initial completion button remains manual. The initial button has a three-attempt limit with a three-second cooldown. Link cards showing LinkedIn’s dated Visited status are recognized without revisiting them; this does not count as completion for video or course cards.
