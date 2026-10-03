/**
 * content.js — LinkedIn Learning Full Course Auto-Completer, Speed Controller & AI Quiz Auto-Solver (v3.2)
 *
 * Features:
 *  1. AI Quiz Auto-Solver (from Coursera AutoPilot):
 *     Automatically parses LinkedIn Learning chapter quizzes and assessments,
 *     constructs structured academic prompts, queries multi-provider AI (Gemini,
 *     Groq, OpenRouter, NVIDIA), marks correct options, and submits answers.
 *  2. Autonomous Course Completer:
 *     Persistent state machine in chrome.storage.local. Seamlessly drives
 *     progression across sections, SPA transitions, and page navigations.
 *  3. 16x High-Speed Playback Engine:
 *     Decoupled audio, pitch correction disabled, and watchdog supervisor.
 *  4. Background Anti-Pause & Audio Keepalive:
 *     Page Visibility spoofing and inaudible audio context prevent background tab freezes.
 */

// ─── State ────────────────────────────────────────────────────────────────────

let currentSpeed = 16;
let autoplayEnabled = true;
let backgroundRun = true;
let speedInjectionEnabled = true;
let autoNavigateEnabled = true;
let skipNonVideos = true;
let autoSolveQuizzes = true;
let focusMode = 'pending_only';
let strictCompletionEnabled = true;
let isBulkActive = false;
let isSolvingQuiz = false;
let quizRunEpoch = 0;
let quizError = null;
let quizErrorUrl = null;
let quizAutoPaused = false;
let isQuizWorkflowRunning = false;
let isDiscoveringPathQueue = false;
let quizContinuationInFlight = false;
let lastQuizContinuationPath = '', lastQuizContinuationAt = 0;
const continuedQuizUrls = new Set();
let videoEl = null;
let watchdogInterval = null;
let lastRecordedTime = -1;
let stuckCount = 0;
let lastRateChangeTime = 0;
let keepalivePort = null;
let keepaliveAudioCtx = null;
let nonVideoTimer = null;
let navWatchdogTimer = null;
let learningPathActive = false;
let lastLearningPathUrl = null;

// Recovery uses elapsed wall time and a per-route budget that survives reloads.
function createPlaybackRecovery(storage) {
  let route = '', lastTime = null, stalledSince = 0, lastRetry = -Infinity, tries = 0;
  const key = 'li-playback-recovery-v1';
  const read = () => { try { return JSON.parse(storage.getItem(key) || '{}'); } catch (_) { return {}; } };
  const write = value => { try { storage.setItem(key, JSON.stringify(value)); } catch (_) {} };
  return {
    step({path, now, active, errorPage = false, retryAvailable = false, videoExpected = false, videoTime = null, ended = false, quiz = false}) {
      if (!active) { route = ''; return null; }
      if (path !== route) { route = path; lastTime = videoTime; stalledSince = now; lastRetry = -Infinity; tries = 0; }
      if (!errorPage && (quiz || !videoExpected)) { stalledSince = now; return null; }
      if (!errorPage && !ended && Number.isFinite(videoTime) && videoTime > (lastTime ?? 0) + 0.05) {
        lastTime = videoTime; stalledSince = now;
        const records = read(); if (records[path]) { delete records[path]; write(records); }
        return null;
      }
      if (errorPage && retryAvailable && tries < 3 && now - lastRetry >= 15000) {
        tries++; lastRetry = now; return 'retry';
      }
      if (now - stalledSince < 60000) return null;
      const records = read();
      const previous = records[path];
      const record = previous && now - previous.since < 600000 ? previous : {since:now, count:0};
      if (record.count >= 2) return 'pause';
      record.count++; write({[path]:record});
      stalledSince = now;
      return 'reload';
    }
  };
}
let playbackRecovery;
let lastRunnerErrorAt = -Infinity;
function recoverBlockedPlayback() {
  const active = !quizAutoPaused && (isBulkActive || autoplayEnabled) && (backgroundRun || !document.hidden);
  const main = document.querySelector('main, [role="main"]') || document.body;
  const text = main?.innerText || '';
  const errorPage = /\boops[!]?/i.test(text) && /it.s (?:not you|us)|give it another try/i.test(text);
  const retry = errorPage && Array.from(main.querySelectorAll('button, a[role="button"]')).find(el =>
    /^try again$/i.test((el.innerText || '').trim()) && isElementClickable(el));
  if (!playbackRecovery) {
    let storage;
    try { storage = window.sessionStorage; } catch (_) {}
    playbackRecovery = createPlaybackRecovery(storage || {getItem:() => null, setItem:() => {}});
  }
  const quiz = !errorPage && isQuizOnPage();
  const video = !quiz && document.querySelector('video');
  const lesson = !quiz && getCourseSyllabus().find(item => item.href === window.location.pathname);
  const action = playbackRecovery.step({
    path:window.location.pathname, now:Date.now(), active,
    errorPage, retryAvailable:!!retry, quiz,
    videoExpected:isBulkActive && !isLearningPathPage() && !!(video || lesson?.isVideo || document.querySelector('.classroom-video-player, [data-test-video-player], .video-js')),
    videoTime:video ? video.currentTime : null, ended:!!video?.ended
  });
  if (action === 'retry') { retry.click(); addLog('LinkedIn error page: clicked Try again.', 'warn'); }
  if (action === 'reload') {
    reloadForPlaybackRecovery();
  }
  if (action === 'pause') {
    quizAutoPaused = true;
    isBulkActive = false;
    chrome.storage.local.set({bulkActive:false});
    const message = 'This page still cannot load after two reloads. Check your connection or sign in, then restart AutoPilot.';
    showHUD(message, 'error'); sendProgress({error:true,isRunning:false,message}); addLog(message, 'error');
  }
  return errorPage || !!action;
}

// Serialize automatic play attempts; Chrome may require muted playback after a reload.
function createManagedPlayback({now, onMuted, onBlocked}) {
  const states = new WeakMap();
  return async function request(video, allowed) {
    if (!video || !allowed() || video.ended || !video.paused || (video.readyState < 2 && !(video.currentSrc || video.src))) return false;
    const state = states.get(video) || {pending:false, lastAttempt:-Infinity, blocked:false};
    states.set(video, state);
    if (state.pending || now() - state.lastAttempt < 2000) return false;
    state.pending = true; state.lastAttempt = now();
    const originalMuted = video.muted;
    let fallback = false;
    try {
      try { await video.play(); }
      catch (error) {
        if (error?.name !== 'NotAllowedError' || !allowed() || originalMuted) throw error;
        fallback = true; video.muted = true;
        await video.play();
      }
      if (fallback) {
        if (allowed()) onMuted(video, originalMuted);
        else video.muted = originalMuted;
      }
      state.blocked = false;
      return !video.paused;
    } catch (error) {
      if (fallback) video.muted = originalMuted;
      if (allowed() && !state.blocked) { state.blocked = true; onBlocked(error); }
      return false;
    } finally { state.pending = false; }
  };
}
const managedPlayback = createManagedPlayback({
  now:() => Date.now(),
  onMuted(video, originalMuted) {
    const message = 'Chrome blocked autoplay with sound. Playback resumed muted; interact with the page to restore sound.';
    showHUD(message, 'warn'); addLog(message, 'warn'); sendProgress({message});
    const restore = event => {
      if (!event.isTrusted) return;
      video.muted = originalMuted;
      document.removeEventListener('pointerdown', restore, true);
      document.removeEventListener('keydown', restore, true);
    };
    document.addEventListener('pointerdown', restore, true);
    document.addEventListener('keydown', restore, true);
  },
  onBlocked(error) {
    const message = error?.name === 'NotAllowedError'
      ? 'Chrome still blocked automatic playback. Open this tab and press Play once.'
      : 'Video playback could not start yet. Waiting for the player to become ready.';
    showHUD(message, 'warn'); addLog(message, 'warn'); sendProgress({message});
  }
});
function requestManagedPlayback(video) {
  const epoch = quizRunEpoch, path = window.location.pathname;
  return managedPlayback(video, () => epoch === quizRunEpoch && path === window.location.pathname &&
    !quizAutoPaused && !isDiscoveringPathQueue && (isBulkActive || autoplayEnabled) &&
    (backgroundRun || !document.hidden) && video.isConnected !== false);
}
let recoveryReloadInFlight = false;
async function reloadForPlaybackRecovery() {
  if (recoveryReloadInFlight || quizAutoPaused) return;
  recoveryReloadInFlight = true;
  const epoch = quizRunEpoch, path = window.location.pathname;
  try {
    // Finish the checkpoint before destroying this document.
    await chrome.storage.local.set({bulkActive:isBulkActive, autoplay:autoplayEnabled, bgPlay:backgroundRun});
    if (epoch !== quizRunEpoch || quizAutoPaused || path !== window.location.pathname) return;
    await addLog('No video progress for one minute. Reloading with AutoPilot settings saved.', 'warn');
    if (epoch === quizRunEpoch && !quizAutoPaused && path === window.location.pathname) window.location.reload();
  } catch (error) {
    addLog('Could not save playback recovery settings: ' + error.message, 'warn');
  } finally { recoveryReloadInFlight = false; }
}

const log = (...args) => console.log('[LI-Learn]', ...args);

async function addLog(message, type = 'info') {
  try {
    const time = new Date().toLocaleTimeString();
    const data = await chrome.storage.local.get(['activityLogs']);
    const logs = data.activityLogs || [];
    logs.unshift({ time, message, type });
    if (logs.length > 80) logs.pop();
    await chrome.storage.local.set({ activityLogs: logs });
  } catch (e) {}
}

// (Page Visibility spoofing loaded via manifest.json at document_start)

// ─── Service Worker Keepalive Port ────────────────────────────────────────────

let keepaliveInterval = null;

function connectKeepalivePort() {
  if (!chrome.runtime?.id) return;

  try {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    keepalivePort = chrome.runtime.connect({ name: 'li-learn-keepalive' });

    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
      if (chrome.runtime?.id) {
        setTimeout(connectKeepalivePort, 5000);
      }
    });

    keepaliveInterval = setInterval(() => {
      try {
        if (chrome.runtime?.id && keepalivePort) {
          keepalivePort.postMessage({ action: 'ping' });
        }
      } catch (e) {}
    }, 25000);
  } catch (e) {
    keepalivePort = null;
  }
}

// Background supervision uses Chrome alarms instead of an always-open ping port.

function startAudioKeepalive() {
  // Non-invasive no-op: background playback is maintained by Page Visibility spoofing in page-inject.js
}

// ─── Course & Syllabus Utilities ─────────────────────────────────────────────

let cachedCourseSlug = null;

function getCourseSlug() {
  const match = window.location.pathname.match(/^\/(?:learning|learning-career-hub|career-hub)\/([^/]+)/);
  const reserved = new Set(['paths', 'learning-paths', 'search', 'me', 'home', 'browse', 'exams', 'career-paths', 'career-journey', 'topics', 'instructors']);
  cachedCourseSlug = match && !reserved.has(match[1]) ? match[1] : null;
  return cachedCourseSlug;
}

function preserveLearningContext(rawHref) {
  const target = new URL(rawHref, window.location.href);
  const current = new URL(window.location.href);
  if (target.origin !== current.origin) throw new Error('Refusing navigation outside LinkedIn');
  for (const key of ['contextUrn', 'u']) {
    if (!target.searchParams.has(key) && current.searchParams.has(key)) {
      target.searchParams.set(key, current.searchParams.get(key));
    }
  }
  return target.href;
}

function validLearningPathUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin &&
      /^\/learning\/(?:paths|learning-paths)\/[^/]+\/?$/.test(url.pathname) ? url.href : null;
  } catch (e) { return null; }
}

function rememberLearningPath() {
  const current = validLearningPathUrl(window.location.href);
  const back = findBackToLearningPathButton();
  const url = current || validLearningPathUrl(back?.getAttribute('href') || back?.href) ||
    validLearningPathUrl(lastLearningPathUrl) || validLearningPathUrl(document.referrer);
  if (!url || url === lastLearningPathUrl) return;
  learningPathActive = true;
  lastLearningPathUrl = url;
  chrome.storage.local.set({ learningPathActive: true, lastLearningPathUrl: url });
}

function isStandalonePathVideo() {
  return new URL(window.location.href).searchParams.get('standalone') === 'true';
}

function isLanguageElement(el) {
  if (!el) return false;
  // If it's inside the quiz challenge, question, assessment, or main classroom content area, it is NOT a language selector!
  if (el.closest('.quiz-challenge, [class*="quiz-challenge"], [class*="assessment-challenge"], main, [role="main"], .classroom-body, [class*="classroom-layout__main"]')) {
    if (!el.closest('.global-footer, .global-footer-compact')) {
      return false;
    }
  }
  // Specific LinkedIn global language dropdowns and controls
  if (el.closest('.language-selector, #language-selector, [data-test-language-selector], [data-control-name*="language" i], [data-control-name*="locale" i]')) return true;
  // Global footer language selector container only
  if (el.closest('.global-footer-compact, .global-footer__language') || (el.closest('.global-footer') && !el.closest('.classroom-nav, .classroom-layout'))) return true;
  // Global LinkedIn primary navigation bar (outside classroom)
  if (el.closest('.global-nav, nav[aria-label="Primary"]') && !el.closest('.classroom-nav, .classroom-layout')) return true;
  return false;
}

function expandAllSections() {
  const sidebar = document.querySelector('.classroom-layout-sidebar-body, .classroom-layout__sidebar-body, .classroom-body__sidebar-body, #course-contents, .classroom-toc');
  if (!sidebar) return;
  const collapsedButtons = sidebar.querySelectorAll(
    'li.classroom-toc-section button[aria-expanded="false"], .classroom-toc-chapter button[aria-expanded="false"], button.classroom-toc-section__toggle[aria-expanded="false"]'
  );
  collapsedButtons.forEach((btn) => {
    if (!isLanguageElement(btn) && !btn.closest('header, nav, footer, .global-nav, .classroom-nav')) {
      try { btn.click(); } catch (e) {}
    }
  });
}

function isLessonCompleted(container) {
  if (!container) return false;
  const fullRow = container.closest('li') || container;

  // Ignore bookmark buttons or actions
  const bookmarkButtons = Array.from(
    fullRow.querySelectorAll('button[aria-label*="bookmark" i], .classroom-toc-item__bookmark, [data-test-icon*="bookmark"]')
  );
  const isInsideBookmark = (el) => {
    for (const b of bookmarkButtons) {
      if (b.contains(el)) return true;
    }
    return false;
  };

  const lessonLink = fullRow.querySelector('a.classroom-toc-item__link');
  if (lessonLink?.hasAttribute('data-live-test-classroom-toc-item-completed')) return true;

  // 1. Text checks (Multilingual: EN, ID, ES, FR, DE)
  const text = ((container.innerText || '') + ' ' + (fullRow.innerText || '')).toLowerCase();
  const completionRegex = /\b(?:completed|watched|viewed|passed|quiz passed|selesai|lulus|ditonton|completado|visto|aprobado|terminé|réussi|abgeschlossen|bestanden)\b/i;
  const negativeRegex = /\b(?:not completed|not viewed|unwatched|not started|belum selesai|belum dimulai|no completado|non terminé)\b/i;

  if (completionRegex.test(text) && !negativeRegex.test(text)) {
    return true;
  }

  // 2. ARIA labels on container and all child elements (excluding bookmarks)
  const ariaEls = Array.from(fullRow.querySelectorAll('[aria-label]')).filter((el) => !isInsideBookmark(el));
  const allAria = [
    container.getAttribute('aria-label') || '',
    fullRow.getAttribute('aria-label') || '',
    ...ariaEls.map((el) => el.getAttribute('aria-label') || '')
  ].join(' ').toLowerCase();

  if (completionRegex.test(allAria) && !negativeRegex.test(allAria)) {
    return true;
  }

  // 3. Screen-reader hidden elements (excluding bookmarks)
  const hiddenElements = Array.from(fullRow.querySelectorAll('.visually-hidden, [class*="hidden"], [class*="sr-only"]')).filter((el) => !isInsideBookmark(el));
  for (const h of hiddenElements) {
    const ht = (h.innerText || '').toLowerCase();
    if (completionRegex.test(ht) && !negativeRegex.test(ht)) return true;
  }

  // 4. Dedicated LinkedIn icon components (excluding bookmarks)
  const iconElements = Array.from(fullRow.querySelectorAll('li-icon, [data-test-icon], [data-icon]')).filter((el) => !isInsideBookmark(el));
  for (const ic of iconElements) {
    const iconType = (
      ic.getAttribute('type') ||
      ic.getAttribute('data-test-icon') ||
      ic.getAttribute('data-icon') ||
      ''
    ).toLowerCase();
    if (iconType.includes('bookmark')) continue;
    if (iconType.includes('circle') || iconType.includes('bullet') || iconType.includes('radio')) return false;
    if (iconType.includes('check') || iconType.includes('completed') || iconType.includes('passed')) {
      return true;
    }
  }

  // 5. SVG checkmarks & green color styles (excluding bookmarks)
  const svgs = Array.from(fullRow.querySelectorAll('svg')).filter((el) => !isInsideBookmark(el));
  for (const svg of svgs) {
    const iconName = (
      svg.getAttribute('data-test-icon') ||
      svg.getAttribute('name') ||
      svg.getAttribute('aria-label') ||
      ''
    ).toLowerCase();
    if (iconName.includes('bookmark')) continue;
    if (iconName.includes('circle') || iconName.includes('bullet') || iconName.includes('radio')) continue;
    if (iconName.includes('check') || iconName.includes('completed') || iconName.includes('passed')) return true;

    const useTags = svg.querySelectorAll('use');
    for (const u of useTags) {
      const href = (u.getAttribute('href') || u.getAttribute('xlink:href') || '').toLowerCase();
      if (href.includes('bookmark')) continue;
      if (href.includes('check') || href.includes('completed')) return true;
    }

    try {
      const stroke = (svg.getAttribute('stroke') || '').toLowerCase();
      const fill = (svg.getAttribute('fill') || '').toLowerCase();
      const style = window.getComputedStyle(svg);
      const color = (style.color || '').toLowerCase();
      const cssFill = (style.fill || '').toLowerCase();
      const cssStroke = (style.stroke || '').toLowerCase();

      const isGreen = (val) =>
        /green|#10b981|#059669|#12884a|#00732f|#057642|#107c41|signal-positive|rgb\(1[0-9],|rgb\(0,\s*1[0-9]|rgb\(5,\s*118|rgb\(16,\s*124|rgb\(18,\s*136/i.test(val);

      if (isGreen(stroke) || isGreen(fill) || isGreen(color) || isGreen(cssFill) || isGreen(cssStroke)) {
        return true;
      }
    } catch (e) {}
  }

  // 6. CSS classes & attributes
  const cls = ((container.className || '') + ' ' + (fullRow.className || '')).toLowerCase();
  if (/classroom-toc-item--completed|has-passed|status--completed/i.test(cls)) {
    return true;
  }
  if (fullRow.getAttribute('data-status') === 'completed' || fullRow.getAttribute('data-test-item-completed') === 'true') {
    return true;
  }

  return false;
}

function getCourseSyllabus() {
  const courseSlug = getCourseSlug();
  if (!courseSlug) return [];

  expandAllSections();

  const sidebar = document.querySelector('.classroom-layout-sidebar-body, .classroom-layout__sidebar-body, .classroom-body__sidebar-body, #course-contents, .classroom-toc');
  let links = [];
  if (sidebar) {
    links = Array.from(sidebar.querySelectorAll('a')).filter((a) => {
      const h = a.getAttribute('href') || a.href || '';
      return h && !h.startsWith('#') && !h.includes('/search') && !a.closest('header, nav[aria-label="Primary" i]');
    });
  }
  if (!sidebar && links.length === 0) {
    links = Array.from(document.querySelectorAll(
      `a[href*="/learning/${courseSlug}/"], a[href*="/learning-career-hub/${courseSlug}/"], a[href*="/career-hub/${courseSlug}/"]`
    ));
  }
  const seen = new Set();
  const lessons = [];

  for (const a of links) {
    const rawHref = a.getAttribute('href') || a.href;
    let lessonUrl;
    try { lessonUrl = new URL(rawHref, window.location.href); } catch (e) { continue; }
    const cleanHref = lessonUrl.pathname;
    if (!cleanHref.startsWith(`/learning/${courseSlug}/`) &&
        !cleanHref.startsWith(`/learning-career-hub/${courseSlug}/`) &&
        !cleanHref.startsWith(`/career-hub/${courseSlug}/`)) continue;

    if (cleanHref.endsWith(`/learning/${courseSlug}`) || cleanHref.endsWith(`/learning/${courseSlug}/`)) {
      continue;
    }

    const title = (a.innerText || '').trim().replace(/\s+/g, ' ') || 'Lesson';
    if (
      /back to|kembali ke|←|↩/i.test(title) ||
      /\b(?:path|jalur)\b/i.test(title) ||
      /\b(?:certificate|certificates|sertifikat|cert|exercise|overview|transcript|notebook|review|share)\b/i.test(cleanHref + ' ' + title)
    ) {
      continue;
    }

    if (!seen.has(cleanHref)) {
      seen.add(cleanHref);
      const rowContainer = a.closest('li') || a.parentElement || a;
      const completed = isLessonCompleted(rowContainer) || hasNetworkCompletion(cleanHref,
        /quiz|assessment|exam/i.test(cleanHref + ' ' + title) ? 'quiz' : 'video');

      const rowText = (rowContainer.innerText || '').toLowerCase();
      const hasVideoDuration = /\b\d+\s*(?:mnt|min|m|sec|dtk|s)\b|\bvideo\b/i.test(rowText);
      const isQuiz = !hasVideoDuration && (
        /\b(?:quiz|kuis|assessment|exam|tes pemahaman|cuestionario|evaluasi)\b/i.test(cleanHref + ' ' + title) ||
        /\d+\s*(?:questions|pertanyaan|preguntas|fragen)/i.test(rowText) ||
        rowContainer.querySelector('[data-test-icon*="quiz"], [type*="quiz"]') !== null
      );
      const isVideo = hasVideoDuration || !isQuiz;

      lessons.push({
        element: a,
        rowContainer,
        href: cleanHref,
        fullHref: preserveLearningContext(rawHref),
        title,
        completed,
        isQuiz,
        isVideo
      });
    }
  }

  return lessons;
}

// ─── Learning Path Auto-Navigation ────────────────────────────────────────────

/**
 * Detects if the current page is a Learning Path overview page
 * (list of courses/videos in a path, NOT inside a specific course player).
 */
function pauseLearningPathVideos() {
  const pathVideos = document.querySelectorAll('video');
  if (pathVideos.length > 0) {
    pathVideos.forEach((v) => {
      try {
        if (!v.paused) v.pause();
        v.muted = true;
        v.removeAttribute('autoplay');
        if (!v._pathPauseBound) {
          v._pathPauseBound = true;
          v.addEventListener('play', () => {
            if (isLearningPathPage()) {
              try {
                v.pause();
                v.muted = true;
              } catch (e) {}
            }
          });
        }
      } catch (e) {}
    });
  }
}

function isLearningPathPage() {
  const path = window.location.pathname.toLowerCase();
  const href = window.location.href.toLowerCase();

  // Must be on a path-like URL
  const isPathUrl =
    path.includes('/paths/') ||
    path.includes('/learning-paths/') ||
    href.includes('/paths/') ||
    href.includes('/learning-paths/');

  if (!isPathUrl) return false;

  // If there's a course syllabus sidebar, we're inside a course
  if (document.querySelector('.classroom-layout-sidebar-body, .classroom-layout__sidebar-body, .classroom-body__sidebar-body, #course-contents, .classroom-toc')) return false;

  return true;
}

/**
 * Detects if the current page is an off-track site navigation route
 * (e.g. Home, Browse, Certifications, Search) that needs escape rescue.
 */
function isGlobalNavPage() {
  const path = window.location.pathname.toLowerCase();
  const href = window.location.href.toLowerCase();

  // If on a path overview page or inside an active course player, it's NOT an off-track global nav page
  if (path.includes('/paths/') || href.includes('/paths/') || path.includes('/learning-paths/') || href.includes('/learning-paths/')) return false;
  if (document.querySelector('.classroom-layout-sidebar-body, .classroom-layout__sidebar-body, .classroom-body__sidebar-body, #course-contents, .classroom-toc')) return false;

  // Known off-track routes that the extension should escape from back to the Learning Path
  if (
    path.includes('/certificates') ||
    path.includes('/certifications') ||
    path.includes('/learning-career-hub/home') ||
    path.includes('/career-hub/home') ||
    path.includes('/learning/browse') ||
    path.includes('/learning-career-hub/browse') ||
    path.includes('/career-hub/browse') ||
    path.includes('/learning-career-hub/certifications') ||
    path.includes('/learning/search') ||
    path.includes('/learning-career-hub/search') ||
    path.includes('/learning/me') ||
    path.includes('/learning-career-hub/me') ||
    path.endsWith('/career-hub') ||
    path.endsWith('/career-hub/') ||
    path.endsWith('/learning-career-hub') ||
    path.endsWith('/learning-career-hub/')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if a Learning Path item (course/video card) is completed.
 * Strict verification: Must explicitly state "Completed" (e.g. "Completed 6/4/2026")
 * or have an explicit checkmark badge. Does NOT treat unfinished progress bars as completed.
 */
function isPathItemCompleted(card) {
  if (!card) return false;
  const text = (card.innerText || '').trim();
  if (/\b(?:not completed|incomplete|remaining)\b/i.test(text)) return false;
  // Use LinkedIn's status on the whole card; progress colors and 100% alone are insufficient.
  return /(?:^|\n)\s*(?:completed|selesai|completado|terminé|abgeschlossen)(?:\s+\d+[/-]\d+[/-]\d+)?\s*(?:\n|$)/i.test(text);
}

/**
 * Extracts course/video items from a Learning Path overview page.
 * Returns array of { title, href, card, completed, type }
 */
function getLearningPathItems() {
  const cards = Array.from(document.querySelectorAll(
    'main .path-body-v2__item-card, main .path-card, main [class*="learning-path__item"], main [class*="learning-path-item"]'
  ));
  const seen = new Set();
  return cards.flatMap(card => {
    const link = card.querySelector('h3 a[href*="/learning/"], h4 a[href*="/learning/"]');
    if (!link) return [];
    let url;
    try { url = new URL(link.getAttribute('href') || link.href, window.location.href); } catch (e) { return []; }
    if (url.origin !== window.location.origin || !/^\/learning\/[^/]+/.test(url.pathname)) return [];
    if (/^\/learning\/(paths|topics|instructors|search|me)\//.test(url.pathname)) return [];
    if (seen.has(url.pathname)) return [];
    seen.add(url.pathname);
    const header = card.querySelector('.lls-card-detail-card-body__header');
    const type = url.searchParams.get('standalone') === 'true' || /(?:^|\n)Video(?:\n|$)/i.test(header?.innerText || '') ? 'video' : 'course';
    return [{ element: link, card, href: url.pathname, fullHref: url.href,
      title: (link.textContent || link.innerText || '').trim(), completed: isPathItemCompleted(card), type }];
  });
}

function findBackToLearningPathButton() {
  // A hidden sidebar anchor still supplies a valid destination; no click is needed.
  const links = Array.from(document.querySelectorAll('a[href]')).filter(link =>
    validLearningPathUrl(link.getAttribute('href') || link.href));
  const explicit = links.find(link => /back to (?:learning )?path|kembali ke (?:jalur|path)/i.test(
    (link.innerText || link.textContent || '') + ' ' + (link.getAttribute('aria-label') || '')));
  if (explicit) return explicit;
  return links.find(link => link.closest('.classroom-layout-sidebar-body, .classroom-layout__sidebar-body, .classroom-body__sidebar-body, .classroom-toc-banner, #course-contents')) || null;
}

async function handleLearningPathStep() {
  if (!isBulkActive || !autoNavigateEnabled) return;
  pauseLearningPathVideos();

  let items = getLearningPathItems();
  if (items.length === 0) {
    for (let retry = 0; retry < 6; retry++) {
      await new Promise((r) => setTimeout(r, 600));
      if (!isBulkActive || !autoNavigateEnabled) return;
      pauseLearningPathVideos();
      items = getLearningPathItems();
      if (items.length > 0) break;
    }
  }

  if (items.length === 0) {
    // Check if there is an explicit Resume or Start button on the page
    const resumeBtn = findButtonByText(/^(?:resume|start|continue|mulai|lanjutkan)(?:\s+(?:learning path|path|jalur))?$/i);
    if (resumeBtn && isElementClickable(resumeBtn)) {
      log('Learning Path: Found Resume/Start button, clicking to continue course:', resumeBtn.innerText);
      showHUD(`▶ Clicking "${resumeBtn.innerText}"...`, 'info');
      clickElement(resumeBtn);
      return;
    }

    log('Learning Path: No uncompleted courses found on page. Waiting for DOM...');
    showHUD('🔍 Scanning Learning Path courses...', 'info');
    setTimeout(runAutonomousStep, 2000);
    return;
  }

  const { pathExamNotice } = await chrome.storage.local.get(['pathExamNotice']);
  if (!isBulkActive || !autoNavigateEnabled) return;
  if (pathExamNotice && validLearningPathUrl(pathExamNotice.pathUrl) &&
      new URL(pathExamNotice.pathUrl).pathname === window.location.pathname) {
    const course = items.find(item => new URL(item.fullHref).pathname.split('/')[2] === pathExamNotice.courseSlug);
    await chrome.storage.local.set({ pathExamNotice: null });
    if (!isBulkActive || !autoNavigateEnabled) return;
    if (course && !course.completed) {
      isBulkActive = false;
      await chrome.storage.local.set({ bulkActive: false });
      const message = `Returned to the path. ${course.title} still needs completion; check its final exam manually, then restart.`;
      showHUD(message, 'warn');
      sendProgress({ error: true, message });
      await addLog(message, 'warn');
      return;
    }
  }

  // Save path state
  learningPathActive = true;
  lastLearningPathUrl = window.location.href;
  await chrome.storage.local.set({
    learningPathActive: true,
    lastLearningPathUrl: window.location.href
  });

  const completedCount = items.filter(i => i.completed).length;
  const totalCount = items.length;
  const pendingCount = totalCount - completedCount;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 100;

  log(`Learning Path: ${completedCount}/${totalCount} items completed (${pendingCount} pending)`);

  sendProgress({
    message: `📚 Learning Path: ${completedCount}/${totalCount} courses completed`,
    percent,
    current: completedCount,
    total: totalCount,
    isRunning: true
  });

  // Check if all items are completed
  if (pendingCount === 0) {
    log('🎉🎉 ENTIRE LEARNING PATH COMPLETED!');
    showHUD('🎉🎉 Entire Learning Path Completed! All courses finished!', 'success');
    await addLog(`🎉 Entire Learning Path completed! (${totalCount}/${totalCount} courses)`, 'success');

    if (await advancePathQueue()) return;
    learningPathActive = false;
    lastLearningPathUrl = null;
    isBulkActive = false;
    await chrome.storage.local.set({
      learningPathActive: false,
      lastLearningPathUrl: null,
      bulkActive: false
    });

    sendProgress({
      message: `🎉🎉 Learning Path complete! (${totalCount}/${totalCount} courses).`,
      percent: 100,
      current: totalCount,
      total: totalCount,
      isDone: true,
      isRunning: false
    });

    applySpeed(videoEl, 1);
    return;
  }

  // Find first uncompleted item
  const nextItem = items.find(i => !i.completed);
  if (!nextItem) {
    // Shouldn't happen if pendingCount > 0, but safety fallback
    log('Learning Path: Could not find uncompleted item despite pending count > 0');
    setTimeout(runAutonomousStep, 3000);
    return;
  }

  log(`Learning Path: Opening next uncompleted course: "${nextItem.title}" → ${nextItem.fullHref}`);
  showHUD(`📚 Opening: ${nextItem.title} (${completedCount + 1}/${totalCount})`, 'info');
  await addLog(`📚 Opening course: ${nextItem.title} (${completedCount + 1}/${totalCount})`, 'info');

  if (!isBulkActive || !autoNavigateEnabled) return;
  // Scroll to and click the course
  isNavigatingToLesson = true;

  if (navWatchdogTimer) clearTimeout(navWatchdogTimer);
  navWatchdogTimer = setTimeout(() => {
    isNavigatingToLesson = false;
    if (isBulkActive && autoNavigateEnabled) {
      log('Learning Path: Navigation timeout. Forcing URL:', nextItem.fullHref);
      window.location.href = nextItem.fullHref;
    }
  }, 5000);

  try {
    if (nextItem.element && nextItem.element.isConnected) {
      nextItem.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 500));
      if (!isBulkActive || !autoNavigateEnabled) return;
      clickElement(nextItem.element);
    } else {
      window.location.href = nextItem.fullHref;
    }
  } catch (e) {
    window.location.href = nextItem.fullHref;
  }
}

/**
 * When a course finishes and learningPathActive is true,
 * return to the Learning Path overview page.
 */
async function returnToLearningPath({ allowAutoplay = false, pendingExam = false } = {}) {
  const epoch = quizRunEpoch;
  const canReturn = () => epoch === quizRunEpoch && autoNavigateEnabled &&
    (isBulkActive || (allowAutoplay && autoplayEnabled));
  if (!canReturn()) return false;
  const stored = await chrome.storage.local.get(['lastLearningPathUrl', 'pathQueueActive', 'pathQueue', 'pathQueueIndex']);
  if (!canReturn()) return false;
  const back = findBackToLearningPathButton();
  const queued = stored.pathQueueActive ? stored.pathQueue?.[stored.pathQueueIndex || 0]?.url : null;
  const target = [queued, back?.getAttribute('href') || back?.href, lastLearningPathUrl,
    stored.lastLearningPathUrl, document.referrer].map(validLearningPathUrl).find(Boolean);
  if (!target) {
    log('Cannot return: no valid learning path URL is available.');
    return false;
  }
  if (new URL(target).pathname === window.location.pathname) return true;
  learningPathActive = true;
  lastLearningPathUrl = target;
  const state = { learningPathActive: true, lastLearningPathUrl: target };
  if (pendingExam) state.pathExamNotice = { pathUrl: target, courseSlug: getCourseSlug() };
  await chrome.storage.local.set(state);
  if (!canReturn()) return false;
  // Cancel a pending lesson-navigation fallback so it cannot undo the return.
  if (navWatchdogTimer) clearTimeout(navWatchdogTimer);
  navWatchdogTimer = null;
  isNavigatingToLesson = true;
  window.location.href = target;
  return true;
}

async function finishCourseAndReturnToPath() {
  const examLink = document.querySelector('a[href*="/learning/exams/summative/"]');
  const pendingExam = !!examLink && !isLessonCompleted(examLink.closest('li') || examLink);
  // Return first. The overview decides whether this course actually needs an exam.
  if (await returnToLearningPath({ pendingExam })) return true;
  if (!isBulkActive) return false;
  if (pendingExam) {
    isBulkActive = false;
    await chrome.storage.local.set({ bulkActive: false });
    const message = 'Course lessons finished. Complete the final exam manually.';
    showHUD(message, 'warn');
    sendProgress({ error: true, message });
    await addLog(message, 'warn');
    return true;
  }
  return false;
}

// ─── Survey / Feedback Overlay Dismissal ──────────────────────────────────────

/**
 * Detects and auto-dismisses LinkedIn Learning survey/feedback overlays
 * (e.g. "How confident are you that you learned valuable skills from this course?")
 * by clicking "Skip survey", "No thanks", "Dismiss", or similar dismiss buttons.
 * Returns true if a survey was found and dismissed.
 */
const surveySkipAttempts = new WeakMap();

function shouldAutoSkipSurvey() {
  return !quizAutoPaused && (isBulkActive || (autoplayEnabled && autoNavigateEnabled && skipNonVideos));
}

function dismissSurveyIfPresent() {
  if (!shouldAutoSkipSurvey()) return false;
  const explicit = /^(?:skip survey|lewati survei|omitir encuesta|passer le sondage|umfrage überspringen)$/i;
  const generic = /^(?:skip|no thanks|dismiss|close|not now|lewati)$/i;
  const surveyPrompt = /how confident are you.*(?:learned|course)|rate (?:this course|your experience)|would you recommend.*course|not very confident.*very confident/i;
  const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]'));
  for (const candidate of candidates) {
    if (isLanguageElement(candidate) || !isElementClickable(candidate) || candidate.getClientRects().length === 0) continue;
    const text = (candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim();
    const aria = (candidate.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    let matches = explicit.test(text) || explicit.test(aria);
    if (!matches && (generic.test(text) || generic.test(aria) || /^(?:close|dismiss) (?:survey|feedback)$/i.test(aria))) {
      const survey = candidate.closest('[class*="survey"], [class*="feedback"], [role="dialog"]');
      matches = !!survey && surveyPrompt.test((survey.innerText || '').replace(/\s+/g, ' '));
    }
    if (!matches) continue;
    const lastAttempt = surveySkipAttempts.get(candidate);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < 1200) return true;
    surveySkipAttempts.set(candidate, Date.now());
    log('Skipping course survey:', text || aria);
    showHUD('⏭️ Skipping survey...', 'info');
    // A native click invokes LinkedIn's skip handler without submitting a rating.
    candidate.click();
    return true;
  }
  return false;
}

// ─── Progress Reporting ───────────────────────────────────────────────────────

let lastProgressSignature = '', lastProgressSentAt = 0;
function sendProgress(data) {
  const signature = JSON.stringify(data), now = Date.now();
  if (!data.error && !data.isDone && signature === lastProgressSignature && now - lastProgressSentAt < 2000) return;
  lastProgressSignature = signature; lastProgressSentAt = now;
  try {
    chrome.runtime.sendMessage({ action: 'bulkProgress', ...data });
  } catch (e) {}

  if (typeof data.percent === 'number') {
    try {
      const badgeText = data.isDone ? 'DONE' : `${data.percent}%`;
      const badgeColor = data.isDone ? '#10b981' : '#0a66c2';
      chrome.runtime.sendMessage({ action: 'updateBadge', text: badgeText, color: badgeColor });
    } catch (e) {}
  }
}

// ─── 🧠 AI Quiz Auto-Solver Engine & On-Screen HUD ─────────────────────────────

let hudTimeout = null;
function showHUD(message, type = 'info') {
  if (backgroundRun && (isBulkActive || isDiscoveringPathQueue) && type !== 'error' && type !== 'warn') return;
  if (!document.body) return;
  let hud = document.getElementById('li-autopilot-hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'li-autopilot-hud';
    hud.style.cssText = `
      position: fixed; bottom: 24px; left: 24px;
      background: rgba(10, 25, 47, 0.96);
      border: 1px solid rgba(56, 189, 248, 0.5);
      color: #f1f5f9; padding: 11px 18px; border-radius: 10px;
      font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px; font-weight: 600; z-index: 2147483647;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
      display: flex; align-items: center; gap: 9px;
      transition: opacity 0.3s ease, transform 0.3s ease;
      backdrop-filter: blur(12px); pointer-events: none;
    `;
    document.body.appendChild(hud);
  }

  if (hudTimeout) clearTimeout(hudTimeout);
  const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : '⚡';
  hud.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  hud.style.display = 'flex';
  hud.style.opacity = '1';
  hud.style.transform = 'translateY(0)';

  hudTimeout = setTimeout(() => {
    if (hud) {
      hud.style.opacity = '0';
      hud.style.transform = 'translateY(8px)';
    }
  }, 4500);
}

function isElementClickable(el) {
  if (!el) return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.classList.contains('disabled') || el.classList.contains('is-disabled')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

function isElementDisabled(el) {
  return !isElementClickable(el);
}

function findButtonByText(pattern, includeDisabled = false) {
  const candidates = Array.from(document.querySelectorAll(
    'button, [role="button"], input[type="button"], input[type="submit"], a, [class*="btn"], [class*="button"]'
  ));
  return candidates.find((el) => {
    if (isLanguageElement(el) || isInsideSidebar(el)) return false;
    if (!includeDisabled && !isElementClickable(el)) return false;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    if (!/certif/i.test(pattern.source) && /certif|sertifikat|\bcerts?\b/i.test(text)) return false;
    if (!/continue watching/i.test(pattern.source) && /continue watching|lanjutkan menonton/i.test(text)) return false;
    return pattern.test(text);
  });
}

function clickElement(el) {
  if (!el || isLanguageElement(el)) return;
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
  } catch (e) {}

  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];
  for (const ev of events) {
    try {
      el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
  }

  try {
    el.click();
  } catch (e) {}
}

function isInsideSidebar(el) {
  if (!el) return false;
  // Match ONLY the actual sidebar contents, TOC list, or aside element.
  // NEVER match layout wrappers with classes like classroom-layout--sidebar-open!
  return !!el.closest(
    '#course-contents, aside, .classroom-layout__sidebar, ul.classroom-toc, li.classroom-toc-item, nav[aria-label="Table of contents" i], .classroom-toc-section'
  );
}

function getQuizResultState() {
  const quiz = document.querySelector('.chapter-quiz, .classroom-quiz, .quiz-challenge');
  const main = document.querySelector('main, .classroom-layout__main, .classroom-body, [role="main"]') || document.body;
  const passedPattern = /\b(?:you passed|quiz passed|assessment complete|(?:you.ve |you have )?completed (?:the |this )?quiz|quiz completed?)\b/i;
  for (const root of [...new Set([quiz, main].filter(Boolean))]) {
    if (root.getClientRects && !root.getClientRects().length) continue;
    const text = root.innerText || '';
    const buttons = Array.from(root.querySelectorAll('button, a[role="button"]')).filter(button =>
      !isInsideSidebar(button) && isElementClickable(button));
    const resultControls = buttons.some(button =>
      /^(?:review (?:all )?answers|continue|continue learning|return to course|back to course|next lesson|continue watching|retake(?: quiz)?)$/i.test((button.innerText || '').trim()));
    const scored = /\byou (?:have )?answered\s+\d+\s+(?:out\s+)?of\s+\d+\s+questions?\b/i.test(text);
    const passed = passedPattern.test(text) || /successfully completed all questions in (?:this|the) quiz/i.test(text);
    if (passed || (scored && resultControls)) return {visible:true, passed, root};
  }
  return {visible:false, passed:false, root:null};
}

function hasActiveQuizQuestion() {
  if (getQuizResultState().visible) return false;
  return Array.from(document.querySelectorAll('.chapter-quiz-question')).some(group =>
    group.getClientRects().length > 0 && group.querySelector('.chapter-quiz-question__question-text') &&
    Array.from(group.querySelectorAll('input[type="radio"], input[type="checkbox"]')).some(input => !input.disabled));
}

function hasPendingQuizStart() {
  if (getQuizResultState().visible) return false;
  const root = document.querySelector('.chapter-quiz, .classroom-quiz, .quiz-challenge');
  return !!root && Array.from(root.querySelectorAll('button')).some(button =>
    /^(?:start|resume|take|begin)\s+quiz$/i.test((button.innerText || '').trim()) && isElementClickable(button));
}

function isQuizOnPage() {
  const mainArea = document.querySelector('main, .classroom-layout__main, .classroom-body, [role="main"]') || document.body;
  const hasCounterOnPage = !!mainArea.querySelector('.quiz-challenge__counter, [class*="question-counter"], .quiz-step-counter');
  const hasQuizCard = !!mainArea.querySelector('.chapter-quiz, .chapter-quiz-question, .quiz-challenge, [class*="quiz-challenge"], .classroom-quiz');
  const bodyText = (document.body ? document.body.innerText : '');
  const hasCounterText = /(?:question|pertanyaan|pregunta|frage)\s+\d+\s+(?:of|dari|de|von|\/)\s+\d+/i.test(bodyText);

  // RULE 0: Check if dedicated quiz elements exist on page first (Question counter, quiz challenge card)
  if (hasCounterOnPage || hasQuizCard || hasCounterText) {
    return true;
  }

  // RULE 1: Check URL pathname specifically for dedicated quiz or assessment routes
  const path = window.location.pathname.toLowerCase();
  if (
    path.includes('/quiz/') ||
    path.includes('/assessment/') ||
    path.includes('/exam/') ||
    path.includes('/cuestionario/') ||
    path.includes('/career-hub') ||
    path.includes('/skill-assessment') ||
    path.includes('/diagnostic')
  ) {
    return true;
  }

  // RULE 2: Career Hub / Assessment Page Text Indicators
  if (/learning career hub/i.test(bodyText) || /select (?:an|one)?\s*answer/i.test(bodyText)) {
    if (/(?:question|pertanyaan|pregunta|frage)\s+\d+\s+(?:of|dari|de|von|\/)\s+\d+/i.test(bodyText)) {
      return true;
    }
  }

  // RULE 3: If an active playing video is present and no quiz elements, it is a video
  if (document.querySelector('video, .classroom-video-player, [data-test-video-player], .video-js, .classroom-layout__video-player')) {
    return false;
  }

  // RULE 4: Check for Start Quiz / Resume Quiz button strictly OUTSIDE sidebar
  const searchRoot = mainArea;
  const buttons = Array.from(searchRoot.querySelectorAll('button, a[role="button"], input[type="button"]')).filter((b) => {
    return !isInsideSidebar(b);
  });
  const hasStartQuizBtn = buttons.some((b) => {
    const t = (b.innerText || b.value || '').trim();
    return /^(?:start|resume|take|begin|retake|restart)\s+quiz/i.test(t) ||
           /^(?:mulai|lanjutkan|ulangi)\s+(?:kuis|tes)/i.test(t);
  });
  if (hasStartQuizBtn) {
    return true;
  }

  // RULE 5: Active sidebar item check ONLY IF it has NO video duration and has explicit quiz title
  const activeSidebarItem = document.querySelector(
    'li.classroom-toc-item--selected, li.selected, li.active, [aria-current="page"]'
  );
  if (activeSidebarItem) {
    const text = (activeSidebarItem.innerText || '').toLowerCase();
    const isVideoItem = /\b\d+\s*(?:mnt|min|m|sec|dtk|s)\b|\bvideo\b/i.test(text);
    if (!isVideoItem && /tes pemahaman|chapter quiz|\bquiz\b|\bkuis\b/i.test(text)) {
      return true;
    }
  }

  return false;
}

function cleanFormulaText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/^(\([a-z0-9]+\)|[a-z0-9][\.\)])\s+/i, '')
    .replace(/\\[a-z]+/gi, '')
    .replace(/[\$\{\}\\]/g, '')
    .replace(/([a-z])_([0-9a-z])/gi, '$1$2')
    .replace(/\s*([=+\-*/^&|])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripAll(s) {
  return cleanFormulaText(s).replace(/[^a-z0-9]/g, '');
}

function stripString(s) {
  return stripAll(s);
}

function isNumericString(s) {
  const trimmed = (s || '').trim();
  return trimmed !== '' && !isNaN(Number(trimmed));
}

function cleanOptionText(text) {
  return (text || '')
    .trim()
    .replace(/^([a-z\d][\.\)]|\([a-z\d]+\))\s+/i, '')
    .replace(/\s+/g, ' ');
}

function isForbiddenQuizButton(b) {
  if (!b) return true;
  const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
  return /previous|return to course|kembali|sebelumnya|certif|sertifikat|\bcerts?\b|continue watching|lanjutkan menonton/i.test(t);
}

function findQuizActionAdvanceButton() {
  const root = document.querySelector('.chapter-quiz, .classroom-quiz, .quiz-challenge') || document.body;
  return Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]')).find(b => {
    const text = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
    return !isInsideSidebar(b) && !isLanguageElement(b) && !isForbiddenQuizButton(b) &&
      /^(?:next|submit|next question|submit and continue|check answer|continue|lanjutkan|berikutnya|kirim)$/i.test(text);
  }) || null;
}

function parseCurrentQuizQuestion() {
  // Current LinkedIn chapter quizzes expose a single question group and native inputs.
  const groups = Array.from(document.querySelectorAll('.chapter-quiz-question')).filter(el => el.getClientRects().length > 0);
  if (groups.length) {
    if (groups.length !== 1) return null;
    const group = groups[0];
    const prompt = group.querySelector('.chapter-quiz-question__question-text')?.innerText?.trim();
    const options = Array.from(group.querySelectorAll('.exam-option')).map(card => {
      const input = card.querySelector('input[type="radio"], input[type="checkbox"]');
      const label = card.querySelector('.exam-option__label');
      const text = card.querySelector('.exam-option__label-text')?.innerText?.trim();
      return { input, label, target: input, text, rawText: text };
    });
    if (!prompt || options.length < 2 || options.some(o => !o.input || o.input.disabled || !o.text) ||
        new Set(options.map(o => o.input.type)).size !== 1) return null;
    const root = group.closest('.chapter-quiz') || group;
    const counter = (root.innerText || '').match(/Question\s+\d+\s+of\s+\d+/i)?.[0] || '';
    return { prompt, counter, type: options[0].input.type, options };
  }

  // 1. Detect Question Counter (e.g. "Question 1 of 12" or "Pertanyaan 1 dari 8")
  let counterText = '';
  let counterEl = null;
  const counterRegex = /(?:question|pertanyaan|pregunta|frage)\s+(\d+)\s+(?:of|dari|de|von|\/)\s+(\d+)/i;
  const allNodes = Array.from(document.querySelectorAll('span, p, div, h2, h3, h4, h5, legend')).filter((el) => {
    if (isInsideSidebar(el)) return false;
    const t = (el.innerText || '').trim();
    return t.length < 35 && (counterRegex.test(t) || /^\d+\s*\/\s*\d+$/.test(t));
  });
  if (allNodes.length > 0) {
    counterEl = allNodes[0];
    counterText = counterEl.innerText.trim();
  }

  // 2. Search root is document.body (safe from header collapse)
  const searchRoot = document.body;

  // 3. Find Options using multiple robust strategies
  const options = [];

  // Strategy 1: Real input elements (radio/checkbox)
  const inputs = Array.from(searchRoot.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter((inp) => {
    return !isInsideSidebar(inp) && !isLanguageElement(inp);
  });
  if (inputs.length >= 2) {
    inputs.forEach((input, idx) => {
      let label = input.closest('label');
      if (!label && input.id) {
        try { label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`); } catch (e) {}
      }
      if (!label) {
        label = input.parentElement;
      }
      const text = label ? label.innerText.trim() : (input.value || `Option ${idx + 1}`);
      options.push({
        input,
        label,
        target: label || input,
        text: cleanOptionText(text),
        rawText: text
      });
    });
  }

  // Strategy 2: ARIA roles (role="radio", role="checkbox", role="option")
  if (options.length === 0) {
    const roles = Array.from(searchRoot.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]')).filter((r) => {
      return !isInsideSidebar(r) && !isLanguageElement(r);
    });
    if (roles.length >= 2) {
      roles.forEach((r, idx) => {
        const text = r.innerText.trim() || `Option ${idx + 1}`;
        options.push({
          input: r.querySelector('input') || null,
          label: null,
          target: r,
          text: cleanOptionText(text),
          rawText: text
        });
      });
    }
  }

  // Strategy 3: Career Hub / Assessment "Select an answer" section discovery
  if (options.length === 0) {
    const selectHeaders = Array.from(searchRoot.querySelectorAll('h1, h2, h3, h4, h5, p, span, div, legend')).filter((el) => {
      if (isInsideSidebar(el) || isLanguageElement(el)) return false;
      const t = (el.innerText || '').trim().toLowerCase();
      return /select (?:an|one)?\s*answer|select all that apply|choose (?:an|the)?\s*answer|pilih (?:satu)?\s*jawaban/i.test(t) && t.length < 60;
    });

    for (const hdr of selectHeaders) {
      const containerCandidates = [
        hdr.nextElementSibling,
        hdr.parentElement?.nextElementSibling,
        hdr.parentElement
      ].filter(Boolean);

      for (const container of containerCandidates) {
        const rawItems = Array.from(container.querySelectorAll(
          'button, [role="button"], [role="radio"], [role="checkbox"], li, label, [class*="card"], [class*="option"], [class*="choice"], [class*="answer"], [class*="item"], div[tabindex="0"], div'
        )).filter((c) => {
          if (isInsideSidebar(c) || isLanguageElement(c) || c === hdr || c.contains(hdr)) return false;
          const txt = (c.innerText || '').trim();
          return txt.length >= 2 && txt.length <= 400 && !/previous|skip|next|submit|return to course|select (?:an|one)?\s*answer/i.test(txt);
        });

        const filteredCards = rawItems.filter((c) => !rawItems.some((other) => other !== c && c.contains(other)));
        if (filteredCards.length >= 2 && filteredCards.length <= 10) {
          filteredCards.forEach((card, idx) => {
            const text = card.innerText.trim();
            options.push({
              input: card.querySelector('input') || null,
              label: card.tagName === 'LABEL' ? card : (card.querySelector('label') || null),
              target: card,
              text: cleanOptionText(text),
              rawText: text
            });
          });
          break;
        }
      }
      if (options.length >= 2) break;
    }
  }

  // Strategy 4: Sibling card / option clusters anywhere in question area
  if (options.length === 0) {
    const allButtons = Array.from(searchRoot.querySelectorAll(
      'button, [role="button"], [role="radio"], [role="checkbox"], [tabindex="0"], label, li, [class*="card"], [class*="option"], [class*="choice"], [class*="answer"], div'
    )).filter((el) => {
      if (isInsideSidebar(el) || isLanguageElement(el)) return false;
      if (counterEl && (el.contains(counterEl) || counterEl.contains(el))) return false;
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length < 2 || txt.length > 400) return false;
      if (/previous|skip|next|submit|return to course|kembali|sebelumnya|berikutnya|select (?:an|one)?\s*answer/i.test(txt)) return false;
      if (el.querySelectorAll('button, [role="button"], [role="radio"], [role="checkbox"], label').length > 0 && el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
      return true;
    });

    const parentGroups = new Map();
    allButtons.forEach((b) => {
      const p = b.parentElement;
      if (p) {
        if (!parentGroups.has(p)) parentGroups.set(p, []);
        parentGroups.get(p).push(b);
      }
    });

    for (const [parent, items] of parentGroups.entries()) {
      if (items.length >= 2 && items.length <= 8) {
        const uniqueTexts = new Set(items.map((it) => it.innerText.trim()));
        if (uniqueTexts.size === items.length) {
          items.forEach((item, idx) => {
            const text = item.innerText.trim();
            options.push({
              input: item.querySelector('input') || null,
              label: item.tagName === 'LABEL' ? item : null,
              target: item,
              text: cleanOptionText(text),
              rawText: text
            });
          });
          break;
        }
      }
    }
  }

  // Strategy 5: Class-based option selectors
  if (options.length === 0) {
    const classSelectors = [
      '[class*="quiz-challenge__answer"]',
      '[class*="quiz-challenge__option"]',
      '[class*="quiz-answer"]',
      '[class*="quiz-option"]',
      '[class*="assessment-option"]',
      '[class*="assessment-choice"]',
      '[class*="artdeco-radio"]',
      '[class*="artdeco-checkbox"]',
      '[class*="choice"]',
      '[class*="answer-option"]',
      '[data-test*="option"]',
      '[data-test*="choice"]',
      '[data-test*="answer"]',
      '[data-control-name*="option"]',
      '[data-control-name*="answer"]'
    ].join(', ');

    const candidates = Array.from(searchRoot.querySelectorAll(classSelectors)).filter((el) => {
      if (isInsideSidebar(el) || isLanguageElement(el)) return false;
      if (counterEl && el.contains(counterEl)) return false;
      const t = el.innerText.trim();
      return t.length >= 2 && t.length <= 400 && !/previous|skip|next|submit|return/i.test(t);
    });

    const filtered = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
    if (filtered.length >= 2 && filtered.length <= 10) {
      filtered.forEach((card, idx) => {
        const text = card.innerText.trim() || `Option ${idx + 1}`;
        options.push({
          input: card.querySelector('input') || null,
          label: card.querySelector('label') || null,
          target: card,
          text: cleanOptionText(text),
          rawText: text
        });
      });
    }
  }

  // 4. Find Prompt Text
  let promptText = '';
  const optionTexts = new Set(options.map((o) => cleanOptionText(o.text).toLowerCase()));

  // Priority: Check dedicated question prompt elements on LinkedIn Learning
  const explicitPrompt = searchRoot.querySelector(
    'legend, .quiz-challenge__prompt, [class*="quiz-challenge__prompt"], [class*="quiz-prompt"], [class*="question-prompt"], [class*="question-text"]'
  );
  if (explicitPrompt && !isInsideSidebar(explicitPrompt)) {
    const epText = (explicitPrompt.innerText || '').trim();
    if (epText.length >= 8 && !/select (?:an|one)?\s*answer/i.test(epText) && !optionTexts.has(cleanOptionText(epText).toLowerCase())) {
      promptText = epText;
    }
  }

  const promptCandidates = Array.from(searchRoot.querySelectorAll(
    'legend, [class*="prompt"], [class*="stem"], [class*="question-title"], [class*="question-text"], [class*="question"], h1, h2, h3, h4, p, div'
  )).filter((el) => {
    if (isInsideSidebar(el) || isLanguageElement(el)) return false;
    if (el.closest('label') || el.closest('[role="radio"]') || el.closest('[role="checkbox"]')) return false;
    const t = (el.innerText || '').trim();
    if (!t || t.length < 8) return false;
    if (t === counterText) return false;
    if (/chapter quiz|tes pemahaman|kuis|up next|career hub|learning career hub|return to course/i.test(t)) return false;
    if (/select (?:an|one)?\s*answer|select all that apply|choose (?:an|the)?\s*answer/i.test(t)) return false;
    if (optionTexts.has(cleanOptionText(t).toLowerCase())) return false;
    if (options.some((o) => o.target && (el.contains(o.target) || o.target.contains(el)))) return false;
    return true;
  });

  if (!promptText && promptCandidates.length > 0) {
    if (counterEl) {
      const afterCounter = promptCandidates.find((el) => {
        return (counterEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      promptText = afterCounter ? afterCounter.innerText.trim() : promptCandidates[0].innerText.trim();
    } else {
      promptText = promptCandidates[0].innerText.trim();
    }
  }

  promptText = promptText.replace(/\s*select (?:an|one)?\s*answer:?\s*$/i, '').trim();

  if (!promptText && counterEl && counterEl.nextElementSibling) {
    promptText = counterEl.nextElementSibling.innerText.trim();
  }

  if (!promptText) {
    promptText = counterText || 'Chapter Quiz Question';
  }

  const codeEl = searchRoot.querySelector('pre, code');
  if (codeEl && !promptText.includes(codeEl.innerText)) {
    promptText += '\n```\n' + codeEl.innerText.trim() + '\n```';
  }

  const isCheckbox = inputs.some((i) => i.type === 'checkbox') ||
    searchRoot.querySelectorAll('[role="checkbox"]').length > 0;

  return {
    counter: counterText,
    prompt: promptText,
    type: isCheckbox ? 'checkbox' : 'radio',
    options
  };
}

// ─── Coursera-Style Quiz Option Selection & Resolution Engine ────────────────

function optionIsSelected(option) {
  const input = option.input || (option.target?.tagName === 'INPUT' ? option.target : option.target?.querySelector('input'));
  if (input) return !!input.checked;
  const target = option.target || option.label || option.card;
  const control = target?.matches?.('[role="radio"], [role="checkbox"]') ? target : target?.querySelector('[role="radio"], [role="checkbox"]');
  const value = control?.getAttribute('aria-checked');
  return value === 'true' ? true : value === 'false' ? false : null;
}

async function selectOption(option, shouldCheck = true) {
  if (!option) return false;
  const input = option.input || (option.target?.tagName === 'INPUT' ? option.target : option.target?.querySelector('input'));
  const target = input || option.label || option.target || option.card;
  if (!target || isLanguageElement(target) || isInsideSidebar(target)) return false;
  const before = optionIsSelected(option);
  if (before === shouldCheck) return true;
  target.click();
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (optionIsSelected(option) === shouldCheck) return true;
  }
  return false;
}

async function selectOptionAndVerify(option) {
  return selectOption(option, true);
}

function matchAnswerIndices(options, ans) {
  if (!options?.length || !ans || ans.error) return [];
  const texts = Array.isArray(ans.answerTexts) ? ans.answerTexts : [];
  const indices = Array.isArray(ans.answerIndices) ? ans.answerIndices : [];
  if (texts.some(t => typeof t !== 'string')) return [];
  if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= options.length)) return [];
  const mapped = [];
  for (const text of texts) {
    const matches = options.flatMap((o, i) => cleanFormulaText(o.text) === cleanFormulaText(text) ? [i] : []);
    if (matches.length !== 1) return [];
    mapped.push(matches[0]);
  }
  const unique = [...new Set(mapped.length ? mapped : indices)];
  if (mapped.length && indices.length && (unique.length !== new Set(indices).size || unique.some(i => !indices.includes(i)))) return [];
  return unique;
}

function resolveSingleChoiceOption(options, ans, knownWrongAnswers = []) {
  const indices = matchAnswerIndices(options, ans);
  if (indices.length !== 1 || knownWrongAnswers.some(t => cleanFormulaText(t) === cleanFormulaText(options[indices[0]].text))) {
    return { index: -1, reason: 'No unambiguous valid single answer' };
  }
  return { index: indices[0], reason: 'Validated option mapping' };
}

function resolveMultipleChoiceOptions(options, ans) {
  return matchAnswerIndices(options, ans).map(index => ({ index, text: options[index].text, reason: 'Validated option mapping' }));
}

function resolveAnswerIndices(question, aiAnswer) {
  if (question.type === 'checkbox') return matchAnswerIndices(question.options, aiAnswer);
  const single = resolveSingleChoiceOption(question.options, aiAnswer);
  return single.index < 0 ? [] : [single.index];
}

const quizWrongAnswersMap = new Map();
const quizCorrectAnswersMap = new Map();

/**
 * Scrapes LinkedIn Learning quiz review screen to learn verified correct and incorrect answers.
 */
function learnFromQuizReviewScreen() {
  try {
    const questionContainers = Array.from(document.querySelectorAll(
      '.quiz-challenge__question, .quiz-review__question, [class*="quiz-challenge"], [class*="assessment-question"], fieldset, form, li.quiz-challenge, [class*="review-question"]'
    ));

    const cards = questionContainers.length > 0 ? questionContainers : Array.from(document.querySelectorAll('[class*="challenge"], [class*="review"], article, section'));

    let learnedCount = 0;
    for (const card of cards) {
      const promptEl = card.querySelector('legend, .quiz-challenge__prompt, [class*="prompt"], [class*="question-text"], h2, h3, h4');
      if (!promptEl) continue;
      const promptText = (promptEl.innerText || '').trim();
      if (promptText.length < 8) continue;
      const qKey = `${getCourseSlug() || ''}:${promptText.toLowerCase()}`;

      // Find options in this card
      const optionEls = card.querySelectorAll('li, label, [role="radio"], [role="checkbox"], [class*="option"], [class*="choice"], [class*="answer"]');
      for (const optEl of optionEls) {
        const optText = cleanOptionText((optEl.innerText || '').trim());
        if (!optText || optText.length < 2) continue;

        const optHtml = optEl.outerHTML.toLowerCase();
        const optAria = (optEl.getAttribute('aria-label') || '').toLowerCase();

        const isCorrect = /correct|benar|richtig|vrai|corretto/i.test(optAria) ||
          optEl.querySelector('[class*="correct"], [data-test-icon*="check"], li-icon[type*="check"]') !== null ||
          /quiz-challenge__status--correct|status--correct|feedback--correct/i.test(optHtml);

        const isIncorrect = /incorrect|salah|falsch|faux|scorretto/i.test(optAria) ||
          optEl.querySelector('[class*="incorrect"], [data-test-icon*="close"], [data-test-icon*="x"]') !== null ||
          /quiz-challenge__status--incorrect|status--incorrect|feedback--incorrect/i.test(optHtml);

        if (isCorrect && !isIncorrect) {
          const correct = quizCorrectAnswersMap.get(qKey) || new Set();
          correct.add(optText);
          quizCorrectAnswersMap.set(qKey, correct);
          learnedCount++;
          log(`Learned CORRECT answer for "${promptText}": "${optText}"`);
        } else if (isIncorrect && !card.querySelector('input[type="checkbox"], [role="checkbox"]')) {
          const wrongList = quizWrongAnswersMap.get(qKey) || [];
          if (!wrongList.includes(optText)) wrongList.push(optText);
          quizWrongAnswersMap.set(qKey, wrongList);
          log(`Learned INCORRECT answer for "${promptText}": "${optText}"`);
        }
      }
    }
    if (learnedCount > 0) {
      log(`Total learned ${learnedCount} verified answers from review screen!`);
      showHUD(`🧠 Learned ${learnedCount} verified answers from review!`, 'success');
    }
  } catch (e) {
    log('Error scraping review screen:', e);
  }
}

async function askAIForQuestion(q) {
  const questionKey = `${getCourseSlug() || ''}:${(q.prompt || '').trim().toLowerCase()}`;

  // 1. Check if we already have the verified correct answer from review feedback!
  const correctAnswers = quizCorrectAnswersMap.get(questionKey);
  const knownCorrectAnswer = correctAnswers?.size === 1 ? [...correctAnswers][0] : null;
  if (knownCorrectAnswer && q.type === 'radio' && q.options.some(o => cleanFormulaText(o.text) === cleanFormulaText(knownCorrectAnswer))) {
    log(`Using verified correct answer for "${q.prompt}": "${knownCorrectAnswer}"`);
    const matchIdx = q.options.findIndex((o) => cleanFormulaText(o.text) === cleanFormulaText(knownCorrectAnswer));
    const targetIdx = matchIdx;
    return {
      answerIndices: [targetIdx],
      answerTexts: [q.options[targetIdx]?.text || knownCorrectAnswer],
      rationale: 'Verified correct from previous attempt review feedback.',
      provider: 'Verified Review Memory'
    };
  }

  const courseTitle = document.querySelector('h1, [data-test-hero-title], .classroom-nav__title, .classroom-sidebar__title')?.innerText?.trim() || document.title;
  const chapterTitle = document.querySelector('li.classroom-toc-section--selected, .classroom-toc-chapter, [aria-current="true"]')?.innerText?.split('\n')?.[0]?.trim() || '';

  const knownWrongAnswers = quizWrongAnswersMap.get(questionKey) || [];

  let prompt = `Answer the course quiz using the supplied question and options.\n`;
  prompt += `Choose the best supported answer. If unsure, return empty answer arrays.\n\n`;
  if (courseTitle) prompt += `COURSE NAME: ${courseTitle}\n`;
  if (chapterTitle) prompt += `CHAPTER / LESSON TOPIC: ${chapterTitle}\n`;
  prompt += `QUESTION TYPE: ${q.type === 'checkbox' ? 'Multiple choice (select ALL that apply)' : 'Single choice (select EXACTLY ONE best answer)'}\n`;
  prompt += `QUESTION PROMPT: ${q.prompt}\n\n`;
  prompt += `OPTIONS:\n`;
  q.options.forEach((opt, oIdx) => {
    prompt += `[Index ${oIdx}]: ${opt.text}\n`;
  });

  if (knownWrongAnswers.length > 0) {
    prompt += `\nCRITICAL NEGATIVE FEEDBACK: The following option(s) were previously tested and confirmed INCORRECT by LinkedIn Learning: ${JSON.stringify(knownWrongAnswers)}. DO NOT select any of these incorrect options!\n`;
  }

  prompt += `\nCRITICAL INSTRUCTIONS:
1. In 'answerIndices', provide the matching 0-based index(es) from the provided Options list (e.g. [1]).
2. In 'answerTexts', provide the EXACT verbatim string(s) from the provided Options list matching your answer.
3. In 'rationale', write one concise sentence explaining why the selected option is correct.
4. For single_choice (radio): select EXACTLY ONE best answer.
5. For multiple_choice (checkbox): select ALL correct options.

Output ONLY a valid JSON object without Markdown formatting:
{
  "answerIndices": [0],
  "answerTexts": ["exact option string"],
  "rationale": "One concise sentence reasoning"
}`;

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'ASK_AI', prompt }, resolve);
  });

  if (!response?.success || !response.text) {
    throw new Error(response?.error || 'AI provider returned no answer. Check your API key.');
  }

  let text = response.text.replace(/```json/gi, '').replace(/```/g, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const s = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (s !== -1 && end !== -1) {
      try { parsed = JSON.parse(text.substring(s, end + 1)); } catch (e2) {}
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      (!Array.isArray(parsed.answerTexts) && !Array.isArray(parsed.answerIndices)) ||
      resolveAnswerIndices(q, parsed).length === 0) {
    throw new Error('AI response did not match the current options. No answer was submitted.');
  }
  parsed.provider = response.provider || 'AI';
  parsed.rawPrompt = prompt;
  parsed.rawResponse = response.text;
  return parsed;
}

async function solveLinkedInQuiz() {
  if (isSolvingQuiz) return false;
  isSolvingQuiz = true;
  quizError = null;
  const runEpoch = quizRunEpoch;

  const sessionQuestions = [];
  let lastProviderUsed = 'AI';
  let lastRawPrompt = '';
  let lastRawResponse = '';

  try {
    log('Starting LinkedIn Chapter Quiz Auto-Solver loop...');
    showHUD('🧠 LinkedIn Quiz Auto-Solver starting...');
    sendProgress({ message: '🧠 Solving Chapter Quiz with AI...' });
    await addLog('Starting Chapter Quiz Auto-Solver...', 'info');

    let step = 0;
    const maxSteps = 40;
    let lastHandledPrompt = '';
    let consecutiveSamePromptCount = 0;

    while (step < maxSteps) {
      step++;
      await new Promise((r) => setTimeout(r, 700));
      if (runEpoch !== quizRunEpoch) return false;

      // Results may retain question/review markup, so check completion before
      // parsing another question or trying to retake a completed practice quiz.
      if (getQuizResultState().visible && await verifyQuizGreenTick(800, window.location.pathname, runEpoch)) break;

      // 1. Check for "Start quiz", "Resume quiz", or "Take quiz" button
      const startBtn = findButtonByText(/start quiz|resume quiz|take quiz|begin quiz|mulai kuis|mulai tes/i);
      if (startBtn && isElementClickable(startBtn)) {
        log('Clicking Start/Resume Quiz button:', startBtn.innerText);
        showHUD(`▶ Clicking "${startBtn.innerText}"...`);
        if (runEpoch !== quizRunEpoch) return false;
        clickElement(startBtn);
        await new Promise((r) => setTimeout(r, 1400));
        continue;
      }

      // 2. Check for "View results" or "See results" button
      const resultsBtn = findButtonByText(/view results|see results|lihat hasil/i);
      if (resultsBtn && isElementClickable(resultsBtn)) {
        log('Clicking View Results button:', resultsBtn.innerText);
        showHUD(`▶ Viewing quiz results...`);
        if (runEpoch !== quizRunEpoch) return false;
        clickElement(resultsBtn);
        await new Promise((r) => setTimeout(r, 1400));
        continue;
      }

      // 3. Check if previous answer was already evaluated and feedback is displayed
      const feedbackPresent = !!document.querySelector(
        '.quiz-challenge__feedback, [class*="feedback"], .quiz-challenge__status, [aria-label*="correct" i], [aria-label*="incorrect" i]'
      );
      const nextQuestionBtn = findButtonByText(/^next question$|^soal berikutnya$/i);
      if ((feedbackPresent || nextQuestionBtn) && nextQuestionBtn && isElementClickable(nextQuestionBtn)) {
        log('Advancing to next question:', nextQuestionBtn.innerText);
        showHUD(`▶ Advancing to next question...`);
        if (runEpoch !== quizRunEpoch) return false;
        clickElement(nextQuestionBtn);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }

      // 4. Parse the current active question (with retries for dynamic mounting)
      let currentQ = parseCurrentQuizQuestion();
      if (!currentQ || currentQ.options.length < 2) {
        for (let r = 0; r < 3; r++) {
          await new Promise((res) => setTimeout(res, 600));
          currentQ = parseCurrentQuizQuestion();
          if (currentQ && currentQ.options.length >= 2) break;
        }
      }

      if (!currentQ || currentQ.options.length < 2) {
        const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
        const resultRoot = document.querySelector('.chapter-quiz, .classroom-quiz, .quiz-challenge');
        if (/\b(?:you passed|quiz passed|assessment complete|(?:you.ve |you have )?completed (?:the |this )?quiz|quiz completed?)\b/i.test(resultRoot?.innerText || '')) break;
        const isFailedScreen = /keep practicing|retake the quiz|take the quiz again|try again|review your answers|answered \d+ of \d+ questions correctly/i.test(bodyText);

        // If quiz was NOT passed, NEVER click continue! Trigger retake or review!
        if (isFailedScreen) {
          log('Quiz score screen: quiz not passed yet. Looking for Retake or Review...');
          const retakeBtn = findButtonByText(/^retake$|retake quiz|take quiz again|try again|restart quiz|take again/i);
          if (retakeBtn && isElementClickable(retakeBtn)) {
            log('Clicking Retake button on score screen:', retakeBtn.innerText);
            showHUD(`▶ Retrying quiz: "${retakeBtn.innerText}"...`);
            if (runEpoch !== quizRunEpoch) return false;
            clickElement(retakeBtn);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          const reviewBtn = findButtonByText(/review all answers|review answers|tinjau jawaban/i);
          if (reviewBtn && isElementClickable(reviewBtn)) {
            log('Clicking Review all answers to learn correct options:', reviewBtn.innerText);
            if (runEpoch !== quizRunEpoch) return false;
            clickElement(reviewBtn);
            await new Promise((r) => setTimeout(r, 2000));
            learnFromQuizReviewScreen();
            const retakeAfterReview = findButtonByText(/^retake$|retake quiz|take quiz again|try again/i);
            if (retakeAfterReview && isElementClickable(retakeAfterReview)) {
              if (runEpoch !== quizRunEpoch) return false;
              clickElement(retakeAfterReview);
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }
          }

          // Stop loop to let the retry engine handle restarting the quiz via TOC
          break;
        }

        // Passed screen: Check for final continue or "Return to course" button
        const finalContinueBtn = findButtonByText(
          /return to course|back to course|kembali ke kursus|submit and continue|next lesson|finish quiz|done/i
        );
        if (finalContinueBtn && isElementClickable(finalContinueBtn) && !isForbiddenQuizButton(finalContinueBtn)) {
          log('Found final submit / return button on passed screen:', finalContinueBtn.innerText);
          showHUD(`✓ Quiz finished! Clicking "${finalContinueBtn.innerText}"...`, 'success');
          sendProgress({ message: `✓ Quiz finished! Clicking "${finalContinueBtn.innerText}"...` });
          await addLog(`✓ Quiz completed! Clicking "${finalContinueBtn.innerText}"`, 'success');
          if (runEpoch !== quizRunEpoch) return false;
          clickElement(finalContinueBtn);
          await new Promise((r) => setTimeout(r, 2000));
          break;
        }

        // Check if there is an un-clicked results or next button
        const lingeringNext = findButtonByText(/^next question$|^view results$|^see results$/i);
        if (lingeringNext && isElementClickable(lingeringNext) && !isForbiddenQuizButton(lingeringNext)) {
          if (runEpoch !== quizRunEpoch) return false;
          clickElement(lingeringNext);
          await new Promise((r) => setTimeout(r, 1400));
          continue;
        }

        // Check if quiz is already marked as completed in syllabus
        expandAllSections();
        const syllabus = getCourseSyllabus();
        const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
        const quizItem = syllabus.find((l) => {
          const h = (l.href || '').toLowerCase();
          return h === currentPath;
        });
        const activeSidebarItem = document.querySelector(
          'li.classroom-toc-item--selected, li.selected, li.active, [aria-current="page"]'
        );

        if ((quizItem && quizItem.completed) || (activeSidebarItem && isLessonCompleted(activeSidebarItem))) {
          log('Quiz item verified completed with green checkmark in syllabus!');
          showHUD('🎉 Chapter Quiz completed & verified!', 'success');
          sendProgress({ message: '✓ Chapter Quiz completed & verified!' });
          await addLog('🎉 Chapter Quiz completed and verified in syllabus!', 'success');
          break;
        }

        throw new Error('Could not read an active quiz question. Wait for the quiz to load, then click Solve Current Quiz.');
      }

      // Anti-loop safeguard: check if stuck on the exact same prompt
      if (currentQ.prompt === lastHandledPrompt) {
        consecutiveSamePromptCount++;
        if (consecutiveSamePromptCount >= 3) {
          throw new Error('Quiz did not advance after submission. Check the current question before retrying.');
        }
      } else {
        lastHandledPrompt = currentQ.prompt;
        consecutiveSamePromptCount = 0;
      }

      const qNumText = currentQ.counter ? `(${currentQ.counter}) ` : '';
      log(`AI Quiz Solver: ${qNumText}${currentQ.prompt}`);
      showHUD(`🧠 ${currentQ.counter || 'Question'}: Solving with AI...`);
      sendProgress({ message: `🧠 Solving ${qNumText}with AI...` });

      // 5. Ask AI for answer
      const aiAnswer = await askAIForQuestion(currentQ);
      if (runEpoch !== quizRunEpoch) return false;
      const freshQuestion = parseCurrentQuizQuestion();
      if (!freshQuestion || freshQuestion.prompt !== currentQ.prompt ||
          JSON.stringify(freshQuestion.options.map(o => o.text)) !== JSON.stringify(currentQ.options.map(o => o.text))) {
        throw new Error('Question changed while the AI request was running. Retry the current quiz.');
      }
      currentQ = freshQuestion;
      let chosenIndices = [];
      let markedTexts = [];
      let matchReason = '';

      lastProviderUsed = aiAnswer.provider || lastProviderUsed;
      lastRawPrompt = aiAnswer.rawPrompt || lastRawPrompt;
      lastRawResponse = aiAnswer.rawResponse || lastRawResponse;

      // 6. Select option(s) in DOM using Coursera Completer engine
      if (currentQ.type === 'checkbox') {
        const resolved = resolveMultipleChoiceOptions(currentQ.options, aiAnswer);
        const resolvedIndices = new Set(resolved.map((r) => r.index));
        chosenIndices = Array.from(resolvedIndices);
        markedTexts = resolved.map((r) => r.text);
        matchReason = 'Multiple-choice matched';

        for (let j = 0; j < currentQ.options.length; j++) {
          const opt = currentQ.options[j];
          const shouldSelect = resolvedIndices.has(j);
          if (runEpoch !== quizRunEpoch) return false;
          if (!await selectOption(opt, shouldSelect)) throw new Error('Could not verify checkbox selection.');
          if (shouldSelect) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        showHUD(`✓ Marked: [${markedTexts.join(', ')}]`);
        log(`Selected checkbox options [${chosenIndices.join(', ')}]: "${markedTexts.join(', ')}"`);
      } else {
        const qKey = `${getCourseSlug() || ''}:${(currentQ.prompt || '').trim().toLowerCase()}`;
        const knownWrong = quizWrongAnswersMap.get(qKey) || [];
        const resolution = resolveSingleChoiceOption(currentQ.options, aiAnswer, knownWrong);
        const chosenIdx = resolution.index;
        if (chosenIdx < 0) throw new Error('No valid answer matched the current question.');
        chosenIndices = [chosenIdx];
        const chosenOpt = currentQ.options[chosenIdx];
        if (chosenOpt) {
          if (!await selectOption(chosenOpt, true)) throw new Error('Could not verify answer selection.');
          markedTexts = [chosenOpt.text];
          matchReason = resolution.reason;
          showHUD(`✓ Selected: "${chosenOpt.text.substring(0, 36)}..."`);
          log(`Selected option [${chosenIdx}]: "${chosenOpt.text}" (${resolution.reason})`);
        }
      }

      // Save question record for popup AI Solution tab
      sessionQuestions.push({
        id: sessionQuestions.length,
        prompt: currentQ.prompt,
        type: currentQ.type,
        options: currentQ.options.map((o) => o.text),
        markedIndex: chosenIndices.length === 1 ? chosenIndices[0] : chosenIndices,
        markedText: markedTexts.join(', '),
        matchReason,
        aiRationale: aiAnswer.rationale || 'Correct choice identified based on standard academic definitions.'
      });

      const quizRecord = {
        timestamp: new Date().toLocaleTimeString(),
        url: window.location.href,
        title: document.querySelector('h1, [data-test-hero-title], .classroom-nav__title')?.innerText?.trim() || document.title,
        providerUsed: lastProviderUsed,
        questions: sessionQuestions,
        rawPrompt: lastRawPrompt,
        rawResponse: lastRawResponse
      };

      try {
        chrome.storage.local.set({
          lastQuizSolution: quizRecord,
          lastGeminiQuizData: quizRecord
        });
      } catch (e) {}

      await addLog(`Marked ${qNumText}: "${markedTexts.join(', ')}" (${lastProviderUsed})`, 'info');

      // Wait 400ms for React state to reconcile
      await new Promise((r) => setTimeout(r, 400));

      if (runEpoch !== quizRunEpoch) return false;
      if (!currentQ.options.every((o, i) => optionIsSelected(o) === chosenIndices.includes(i))) {
        throw new Error('Selected answers do not match the expected options.');
      }
      // 7. Find and click question Submit or Advance button
      let advanceBtn = null;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 3000) {
        if (runEpoch !== quizRunEpoch) return false;
        advanceBtn = findQuizActionAdvanceButton();
        if (advanceBtn && isElementClickable(advanceBtn)) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      if (advanceBtn && isElementClickable(advanceBtn)) {
        const btnText = (advanceBtn.innerText || advanceBtn.value || advanceBtn.getAttribute('aria-label') || 'Submit').trim();
        log('Clicking Quiz Advance/Submit button:', btnText);
        showHUD(`▶ Submitting: "${btnText}"...`);
        if (runEpoch !== quizRunEpoch) return false;
        clickElement(advanceBtn);
      } else {
        throw new Error('Submit is disabled or unavailable; the quiz was left unchanged.');
      }

      // Wait 1.4s for LinkedIn to evaluate and transition
      await new Promise((r) => setTimeout(r, 1400));

      // Record incorrect answers in memory so retries eliminate wrong options
      const isIncorrectFeedback = !!document.querySelector('.quiz-challenge__feedback--incorrect, [class*="feedback--incorrect"], [class*="status--incorrect"], [aria-label*="incorrect" i]');
      const feedbackText = (document.querySelector('.quiz-challenge__feedback, [class*="feedback"], .quiz-challenge__status')?.innerText || '').toLowerCase();
      if (isIncorrectFeedback || feedbackText.includes('incorrect') || feedbackText.includes('salah')) {
        const qKey = `${getCourseSlug() || ''}:${(currentQ.prompt || '').trim().toLowerCase()}`;
        const wrongList = quizWrongAnswersMap.get(qKey) || [];
        for (const t of currentQ.type === 'radio' ? markedTexts : []) {
          if (!wrongList.includes(t)) wrongList.push(t);
        }
        quizWrongAnswersMap.set(qKey, wrongList);
        log(`Recorded wrong answer for "${currentQ.prompt}":`, wrongList);
      }

      // 8. If follow-up "Next question", "Next", or "Submit and continue" appeared after submission
      const followUpBtn = findButtonByText(
        /submit and continue|next question|^next$|lanjutkan|berikutnya|view results|see results|continue/i
      );
      if (followUpBtn && isElementClickable(followUpBtn) && !isForbiddenQuizButton(followUpBtn)) {
        log('Clicking follow-up advance button:', followUpBtn.innerText);
        showHUD(`▶ Advancing: "${followUpBtn.innerText}"...`);
        if (runEpoch !== quizRunEpoch) return false;
        clickElement(followUpBtn);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    log('Chapter Quiz solving loop ended.');
    await new Promise((r) => setTimeout(r, 1200));
    isSolvingQuiz = false;
    return true;
  } catch (err) {
    if (runEpoch !== quizRunEpoch) return false;
    // A result can appear between parsing and submission. Preserve AutoPilot
    // when the current quiz has finished instead of reporting a parse failure.
    if (getQuizResultState().visible && await verifyQuizGreenTick(800, window.location.pathname, runEpoch)) {
      quizError = null; quizErrorUrl = null;
      return true;
    }
    if (runEpoch !== quizRunEpoch) return false;
    log('Quiz solver error:', err);
    showHUD('❌ Quiz solver error: ' + err.message, 'error');
    quizError = err.message;
    quizErrorUrl = window.location.href.split('?')[0].split('#')[0];
    if (isBulkActive) {
      isBulkActive = false;
      await chrome.storage.local.set({ bulkActive: false });
    }
    await addLog(`Quiz paused: ${err.message}`, 'error');
    sendProgress({ error: true, message: err.message });
    return false;
  } finally {
    isSolvingQuiz = false;
  }
}

// ─── 🛡️ Green Tick Verification & Auto-Retry Engine ─────────────────────────

const networkCompletionSignals = new Map();
let networkSignalsSince = Date.now();
let lastNetworkFailureLog = 0;
function resetNetworkCompletionSignals() {
  networkSignalsSince = Date.now();
  networkCompletionSignals.clear();
}
function hasNetworkCompletion(path, kind) {
  const signal = networkCompletionSignals.get(path);
  return !!signal && signal.kind === kind && signal.startedAt >= networkSignalsSince &&
    Date.now() - signal.observedAt < 120000;
}
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== 'LI_NETWORK_STATUS') return;
  const signal = event.data;
  if (!['video','quiz'].includes(signal.kind) || !['COMPLETED','IN_PROGRESS','NOT_STARTED','FAILED'].includes(signal.status) ||
      signal.path !== window.location.pathname || !Number.isFinite(signal.startedAt) || !Number.isFinite(signal.observedAt) ||
      signal.startedAt < networkSignalsSince || signal.observedAt < signal.startedAt ||
      signal.observedAt > Date.now() + 1000 || Date.now() - signal.observedAt > 120000 || quizAutoPaused) return;
  if (signal.status === 'COMPLETED') {
    networkCompletionSignals.set(signal.path, {kind:signal.kind,startedAt:signal.startedAt,observedAt:signal.observedAt});
    if (networkCompletionSignals.size > 50) networkCompletionSignals.delete(networkCompletionSignals.keys().next().value);
    setTimeout(() => {
      if (quizAutoPaused || isDiscoveringPathQueue || window.location.pathname !== signal.path) return;
      if (isBulkActive) runAutonomousStep();
      else checkAndAutoSolveQuiz();
    }, 150);
  } else {
    networkCompletionSignals.delete(signal.path);
    if (signal.status === 'FAILED' && Date.now() - lastNetworkFailureLog > 30000) {
      lastNetworkFailureLog = Date.now();
      addLog('LinkedIn did not accept a progress update. Waiting for verified completion; the request was not replayed.', 'warn');
    }
  }
});

async function verifyQuizGreenTick(maxWaitMs = 5000, quizPath = window.location.pathname, epoch = quizRunEpoch) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (epoch !== quizRunEpoch) return false;
    if (window.location.pathname === quizPath && (hasActiveQuizQuestion() || hasPendingQuizStart())) return false;
    if (window.location.pathname === quizPath && hasNetworkCompletion(quizPath, 'quiz')) return true;
    expandAllSections();
    const item = getCourseSyllabus().find(l => l.href === quizPath);
    if (item?.completed) return true;
    // A score alone is not completion. Practice quizzes can be marked complete
    // with "Keep practicing"; assessments still require verified completion.
    if (window.location.pathname === quizPath && getQuizResultState().passed) return true;
    await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

async function continueAfterQuiz(quizPath = window.location.pathname, epoch = quizRunEpoch) {
  const allowed = () => epoch === quizRunEpoch && !quizAutoPaused && autoNavigateEnabled &&
    !isDiscoveringPathQueue && (isBulkActive || autoplayEnabled);
  if (!allowed() || quizContinuationInFlight) return false;
  if (lastQuizContinuationPath === quizPath && Date.now() - lastQuizContinuationAt < 2500) return false;
  lastQuizContinuationPath = quizPath; lastQuizContinuationAt = Date.now();
  if (window.location.pathname !== quizPath) return true;
  quizContinuationInFlight = true;
  try {
    const stored = await chrome.storage.local.get(['focusMode']);
    if (!allowed()) return false;
    const mode = isBulkActive ? (stored.focusMode || focusMode) : 'pending_only';
    expandAllSections();
    const syllabus = getCourseSyllabus().map(item => item.href === quizPath ? {...item, completed:true} : item);
    const eligible = item => !item.completed && item.href !== quizPath &&
      (mode === 'videos_only' ? item.isVideo : mode === 'quizzes_only' ? item.isQuiz : true);
    const index = syllabus.findIndex(item => item.href === quizPath);
    const next = syllabus.find(eligible);
    if (next) {
      if (!allowed()) return false;
      if (navigateToLesson(next, {allowAutoplay:true})) {
        continuedQuizUrls.add(quizPath);
        return true;
      }
    }
    if (syllabus.length && !syllabus.some(eligible)) {
      const returned = isBulkActive ? await finishCourseAndReturnToPath() : await returnToLearningPath({allowAutoplay:true});
      if (!allowed()) return returned;
      if (!returned && isBulkActive) {
        isBulkActive = false;
        await chrome.storage.local.set({bulkActive:false});
        sendProgress({isDone:true,isRunning:false,percent:100,message:'All course items completed.'});
      }
      continuedQuizUrls.add(quizPath);
      return true;
    }
    const root = getQuizResultState().root;
    const button = root && Array.from(root.querySelectorAll('button, a[role="button"]')).find(el =>
      /^(?:return to course|back to course|continue learning|next lesson|continue watching|continue)$/i.test((el.innerText || '').trim()) && isElementClickable(el));
    if (button && allowed()) { button.click(); continuedQuizUrls.add(quizPath); return true; }
    return false;
  } finally { quizContinuationInFlight = false; }
}

async function solveLinkedInQuizWithGreenTickRetry(maxRetries = 5) {
  if (isSolvingQuiz || isQuizWorkflowRunning) return false;
  isQuizWorkflowRunning = true;
  try {
    const retryEpoch = quizRunEpoch;
    const quizPath = window.location.pathname;
    continuedQuizUrls.delete(quizPath);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (retryEpoch !== quizRunEpoch) return false;
      if (getQuizResultState().visible && await verifyQuizGreenTick(800, quizPath, retryEpoch)) {
        if (retryEpoch !== quizRunEpoch) return false;
        quizError = null; quizErrorUrl = null;
        solvedQuizUrls.add(window.location.origin + quizPath);
        await continueAfterQuiz(quizPath, retryEpoch);
        return true;
      }
      log(`Starting Quiz Attempt ${attempt}/${maxRetries}...`);
      showHUD(`🧠 Auto-Solving Quiz: Attempt ${attempt}/${maxRetries}...`);

      const solved = await solveLinkedInQuiz();
      if (!solved || quizError) return false;

      // Pause 2s for LinkedIn backend to process answers and update checkmark
      showHUD('⏳ Verifying green tick in syllabus...');
      await new Promise((r) => setTimeout(r, 2000));

      const isVerified = await verifyQuizGreenTick(4000, quizPath, retryEpoch);
      if (retryEpoch !== quizRunEpoch) return false;
      if (isVerified) {
        log('🎉 Green tick / Completion CONFIRMED on quiz!');
        showHUD('✅ Verified! Quiz completed.', 'success');
        sendProgress({ message: '🎉 Chapter Quiz verified!' });

        solvedQuizUrls.add(window.location.origin + quizPath);
        await continueAfterQuiz(quizPath, retryEpoch);
        return true;
      }

      // No green tick verified -> Retry
      log(`⚠️ Attempt ${attempt}: No green tick detected on syllabus. Retrying quiz...`);
      showHUD(`⚠️ Quiz not passed. Retrying quiz (attempt ${attempt + 1})...`, 'warn');

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1200));

        // 1. Look for Retake / Try again / Take quiz again button
        const retakeBtn = findButtonByText(
          /^retake$|retake quiz|take quiz again|try again|restart quiz|take again|resume exam|retake exam|take exam|resume quiz|retake assessment/i
        );
        if (retakeBtn && isElementClickable(retakeBtn)) {
          log('Clicking Retake Quiz button:', retakeBtn.innerText);
          showHUD(`▶ Clicking "${retakeBtn.innerText}"...`);
          if (retryEpoch !== quizRunEpoch) return false;
          clickElement(retakeBtn);
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          // 2. Check for "Review all answers" button to see explanations and reveal Retake button
          const reviewBtn = findButtonByText(/review all answers|review answers|tinjau jawaban/i);
          if (reviewBtn && isElementClickable(reviewBtn)) {
            log('Clicking Review all answers to learn correct options:', reviewBtn.innerText);
            if (retryEpoch !== quizRunEpoch) return false;
            clickElement(reviewBtn);
            await new Promise((r) => setTimeout(r, 2000));
            learnFromQuizReviewScreen();
            const retakeAfter = findButtonByText(/^retake$|retake quiz|take quiz again|try again|restart quiz/i);
            if (retakeAfter && isElementClickable(retakeAfter)) {
              if (retryEpoch !== quizRunEpoch) return false;
              clickElement(retakeAfter);
              await new Promise((r) => setTimeout(r, 2000));
            }
          } else {
            // 3. Fallback: Click Chapter Quiz in TOC sidebar to restart the quiz attempt
            const tocQuiz = document.querySelector(
              'li.classroom-toc-item--selected a, #course-contents a[href*="/quiz/"]'
            );
            if (tocQuiz && isElementClickable(tocQuiz)) {
              log('Clicking Chapter Quiz in TOC sidebar to reset attempt...');
              if (retryEpoch !== quizRunEpoch) return false;
              clickElement(tocQuiz);
              await new Promise((r) => setTimeout(r, 2500));
            }
          }
        }
      }
    }

    quizError = 'Quiz completion could not be verified after retries. Check the Activity Log and retry manually.';
    quizErrorUrl = window.location.href.split('?')[0].split('#')[0];
    if (isBulkActive) { isBulkActive = false; await chrome.storage.local.set({bulkActive:false}); }
    await addLog(quizError, 'error');
    sendProgress({error:true,message:quizError});
    log('Reached maximum quiz retry attempts.');
    showHUD('❌ Quiz not verified by green tick after retries.', 'error');
    return false;
  } finally {
    isQuizWorkflowRunning = false;
  }
}

const solvedQuizUrls = new Set();
let quizAutoTriggerTimer = null;
let lastQuizCheckTime = 0;

function checkAndAutoSolveQuiz() {
  const currentCleanUrl = window.location.href.split('?')[0].split('#')[0];
  if (quizErrorUrl && quizErrorUrl !== currentCleanUrl) { quizError = null; quizErrorUrl = null; }
  if (isDiscoveringPathQueue || isBulkActive || isSolvingQuiz || isQuizWorkflowRunning || quizAutoPaused || !autoSolveQuizzes || quizError) return;
  if (!isQuizOnPage()) return;
  const active = hasActiveQuizQuestion() || hasPendingQuizStart();
  if (!active && solvedQuizUrls.has(currentCleanUrl)) { continueAfterQuiz(window.location.pathname); return; }
  const now = Date.now();
  if (now - lastQuizCheckTime < 2000 || quizAutoTriggerTimer) return;
  lastQuizCheckTime = now;
  if (!active) {
    const quizItem = getCourseSyllabus().find(l => l.href === window.location.pathname);
    if (quizItem?.completed) { solvedQuizUrls.add(currentCleanUrl); continueAfterQuiz(window.location.pathname); return; }
  }
  const epoch = quizRunEpoch;
  quizAutoTriggerTimer = setTimeout(() => {
    quizAutoTriggerTimer = null;
    const url = window.location.href.split('?')[0].split('#')[0];
    if (epoch !== quizRunEpoch || url !== currentCleanUrl || isBulkActive || isSolvingQuiz ||
        isQuizWorkflowRunning || quizAutoPaused || quizError || !autoSolveQuizzes || !isQuizOnPage()) return;
    solveLinkedInQuizWithGreenTickRetry().then(ok => {
      if (ok) solvedQuizUrls.add(currentCleanUrl);
    });
  }, 1500);
}

// ─── Autonomous Bulk Video Completer (Videos Only Mode) ──────────────────────

let isRunningAutonomousStep = false;
let isNavigatingToLesson = false;
let lastStepRunTime = 0;

let standaloneReturnPending = false;

async function runStandalonePathVideo() {
  const video = document.querySelector('video');
  if (!video) return;
  attachToVideo(video);
  applySpeed(video, currentSpeed);
  if (video.ended) {
    if (standaloneReturnPending || !autoNavigateEnabled) return;
    standaloneReturnPending = true;
    try {
      await new Promise(r => setTimeout(r, 1500));
      if (isBulkActive && autoNavigateEnabled) await returnToLearningPath();
    } finally { standaloneReturnPending = false; }
  } else if (video.paused && (backgroundRun || !document.hidden)) {
    requestManagedPlayback(video);
  }
}

async function runAutonomousStep() {
  if (isDiscoveringPathQueue || !isBulkActive || (!backgroundRun && document.hidden)) return;
  if (isRunningAutonomousStep || isNavigatingToLesson) {
    return;
  }

  const now = Date.now();
  if (now - lastStepRunTime < 800) return;
  lastStepRunTime = now;

  isRunningAutonomousStep = true;

  try {
    startAudioKeepalive();
    rememberLearningPath();
    if (isStandalonePathVideo()) {
      await runStandalonePathVideo();
      return;
    }

    // -1. LEARNING PATH CHECK: If on a path overview page, navigate into first uncompleted course
    if (isLearningPathPage()) {
      await handleLearningPathStep();
      return;
    }

    // -0.5. SURVEY CHECK: Auto-skip feedback surveys that block progress
    if (dismissSurveyIfPresent()) {
      await new Promise(r => setTimeout(r, 1500));
      return; // Re-run step after survey is dismissed
    }

    // -0.4. GLOBAL NAV / CERTIFICATES / OFF-TRACK ESCAPE RESCUE
    if (isGlobalNavPage()) {
      log('Detected on off-track global nav page (' + window.location.pathname + '). Returning to Learning Path...');
      showHUD('↩ Escaping global nav... Returning to Learning Path', 'warn');
      const returned = await returnToLearningPath();
      if (!returned) {
        window.history.back();
      }
      return;
    }

    // 0. CHECK FIRST: If page is a quiz or Career Hub assessment, check completion first then solve!
    if (isQuizOnPage()) {
      // 0a. GREEN TICK CHECK ON QUIZ: If this quiz ALREADY has a green checkmark or is already passed, SKIP IT!
      const alreadyPassed = await verifyQuizGreenTick(800);
      if (!isBulkActive) return;
      if (alreadyPassed) {
        log('⏩ Quiz already passed with green tick! Skipping to next task...');
        showHUD('⏩ Quiz already completed! Skipping to next task...', 'success');

        await continueAfterQuiz(window.location.pathname);
        return;
      }

      const storedConfig = await chrome.storage.local.get([
        'focusMode',
        'autoSolveQuizzes',
        'autoSolve'
      ]);
      const activeFocusMode = storedConfig.focusMode || focusMode || 'pending_only';
      const autoSolve = storedConfig.autoSolve !== undefined ? storedConfig.autoSolve : (storedConfig.autoSolveQuizzes !== undefined ? storedConfig.autoSolveQuizzes : true);

      if (activeFocusMode === 'videos_only') {
        log('Quiz/Assessment detected on page but focus mode is videos_only.');
        showHUD('⏩ Skipping quiz (videos-only mode)...');
        const returnBtn = findButtonByText(/return to course|back to course|kembali ke kursus/i);
        if (returnBtn && isElementClickable(returnBtn)) {
          clickElement(returnBtn);
          await new Promise((r) => setTimeout(r, 2000));
        }
        return;
      }

      if (autoSolve) {
        log('Quiz/Assessment detected on page! Solving with AI...');
        showHUD('🧠 Auto-Solving Assessment / Quiz with AI...');
        await solveLinkedInQuizWithGreenTickRetry();
        return;
      }
    }

    expandAllSections();

    const courseSlug = getCourseSlug();
    if (!courseSlug) return;

    const syllabus = getCourseSyllabus();
    if (syllabus.length === 0) {
      log('Syllabus not loaded yet, waiting 1s...');
      setTimeout(runAutonomousStep, 1000);
      return;
    }

    const storedConfig = await chrome.storage.local.get([
      'focusMode',
      'playbackSpeed',
      'speedInjection',
      'autoSolveQuizzes',
      'autoSolve',
      'strictCompletion'
    ]);

    const activeFocusMode = storedConfig.focusMode || focusMode || 'pending_only';
    const targetSpeed = storedConfig.playbackSpeed !== undefined ? parseFloat(storedConfig.playbackSpeed) : (currentSpeed || 16.0);
    const isSpeedEnabled = storedConfig.speedInjection !== undefined ? !!storedConfig.speedInjection : true;
    const autoSolve = storedConfig.autoSolve !== undefined ? storedConfig.autoSolve : (storedConfig.autoSolveQuizzes !== undefined ? storedConfig.autoSolveQuizzes : true);

    // Target items pool based on focus mode
    let targetLessons = syllabus;
    if (activeFocusMode === 'videos_only') {
      targetLessons = syllabus.filter((l) => l.isVideo);
    } else if (activeFocusMode === 'quizzes_only') {
      targetLessons = syllabus.filter((l) => l.isQuiz);
    } else {
      // 'pending_only' or 'all': all items in course
      targetLessons = syllabus;
    }

    const totalTarget = targetLessons.length;
    const completedTarget = targetLessons.filter((l) => l.completed).length;
    const pendingTarget = targetLessons.filter((l) => !l.completed).length;
    const percent = totalTarget > 0 ? Math.round((completedTarget / totalTarget) * 100) : 100;

    log(`Autonomous Runner: ${completedTarget}/${totalTarget} items completed (${pendingTarget} pending, ${percent}%) [Mode: ${activeFocusMode}]`);

    // 1. Check if all target items in course are completed
    if (pendingTarget === 0 || (completedTarget >= totalTarget && totalTarget > 0)) {
      log(`🎉 All target items in course completed (${completedTarget}/${totalTarget})! Focus Mode: ${activeFocusMode}`);
      await addLog(`🎉 All target items completed! (${completedTarget}/${totalTarget} verified, mode: ${activeFocusMode})`, 'success');

      // If we're in a Learning Path workflow, return to path page instead of stopping
      const pathReturned = await finishCourseAndReturnToPath();
      if (pathReturned) {
        // Keep isBulkActive = true so AutoPilot continues on the next course
        return;
      }

      // Not in a learning path — stop AutoPilot
      isBulkActive = false;
      await chrome.storage.local.set({ bulkActive: false });

      sendProgress({
        message: `🎉 All items completed! (${completedTarget}/${totalTarget} verified).`,
        percent: 100,
        current: completedTarget,
        total: totalTarget,
        isDone: true,
        isRunning: false
      });

      applySpeed(videoEl, 1);
      return;
    }

    // 2. Identify current lesson & check if it already has a green tick
    const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
    const currentLessonIndex = syllabus.findIndex((l) => {
      const h = (l.href || '').toLowerCase();
      return h.includes(currentPath) || currentPath.includes(h);
    });
    const currentLesson = currentLessonIndex !== -1 ? syllabus[currentLessonIndex] : null;

    // Check active item in sidebar for green tick as well
    const activeSidebarItem = document.querySelector(
      'li.classroom-toc-item--selected, li.selected, li.active, [aria-current="page"], [aria-selected="true"]'
    );
    const activeIsCompleted = currentLesson ? currentLesson.completed :
      (activeSidebarItem && isLessonCompleted(activeSidebarItem.closest('li') || activeSidebarItem));

    // If current item (video or quiz) has a green checkmark, skip immediately!
    if (activeIsCompleted) {
      log(`⏩ Current item "${currentLesson?.title || 'Active'}" already verified with green tick. Skipping immediately...`);
      showHUD(`⏩ Green tick verified! Skipping to next task...`, 'info');
      await advanceToNextItem(syllabus, currentLessonIndex, activeFocusMode);
      return;
    }

    sendProgress({
      message: currentLesson
        ? `Processing [${activeFocusMode}]: ${currentLesson.title} (${completedTarget + 1}/${totalTarget})`
        : `Advancing course (${completedTarget}/${totalTarget} verified)...`,
      percent,
      current: completedTarget,
      total: totalTarget,
      isRunning: true
    });

    // 3. Classify whether current page is an active Video or Quiz
    const isCurrentQuiz = (
      isQuizOnPage() ||
      currentPath.includes('/quiz/') ||
      currentPath.includes('/assessment/') ||
      currentPath.includes('/exam/') ||
      (currentLesson && currentLesson.isQuiz)
    );

    const video = !isCurrentQuiz ? document.querySelector('video') : null;
    const hasVideo = !!video;
    const isCurrentVideo = !isCurrentQuiz && (hasVideo || (currentLesson && currentLesson.isVideo));

    // 4. If currently on a Quiz:
    if (isCurrentQuiz) {
      if (activeFocusMode === 'videos_only') {
        log('Current item is a Quiz & focus mode is videos_only. Skipping to next uncompleted video...');
        showHUD('⏩ Skipping quiz (videos-only mode)...');
        await advanceToNextItem(syllabus, currentLessonIndex, activeFocusMode);
        return;
      }

      // Quizzes_only or all or pending_only: Solve with AI!
      if (autoSolve) {
        log('Current item is an Uncompleted Quiz! Solving with AI & Green Tick verification...');
        showHUD('🧠 Auto-Solving Quiz with AI & verifying green tick...');
        await solveLinkedInQuizWithGreenTickRetry();
        return;
      }
    }

    // 5. If currently on a Video but in quizzes_only mode:
    if (activeFocusMode === 'quizzes_only' && isCurrentVideo) {
      log('Current item is a Video & focus mode is quizzes_only. Skipping to next uncompleted quiz...');
      showHUD('⏩ Skipping video (quizzes-only mode)...');
      await advanceToNextItem(syllabus, currentLessonIndex, activeFocusMode);
      return;
    }

    // 6. If current lesson is already completed (has green checkmark):
    if (currentLesson && currentLesson.completed) {
      log(`Lesson "${currentLesson.title}" already verified with green tick. Navigating to next uncompleted task...`);
      showHUD(`⏩ "${currentLesson.title}" already completed, jumping to next task...`);
      await advanceToNextItem(syllabus, currentLessonIndex, activeFocusMode);
      return;
    }

    // 7. If on an uncompleted lesson with an active video element:
    if (video) {
      attachToVideo(video);
      const speedToApply = isSpeedEnabled ? targetSpeed : 1;
      applySpeed(video, speedToApply);

      if (video.ended) {
        log('Video is already ended. Advancing to next item...');
        await handleVideoEnded(currentPath, currentLessonIndex, activeFocusMode);
        return;
      }

      showHUD(`▶ Playing video at ${speedToApply}x (${Math.round(video.currentTime)}s / ${Math.round(video.duration || 0)}s)...`);

      if (video.paused) requestManagedPlayback(video);

      return;
    }

    // Wait for this lesson instead of skipping a player that has not mounted.
    recoverBlockedPlayback();
  } catch (error) {
    if (Date.now() - lastRunnerErrorAt >= 30000) {
      lastRunnerErrorAt = Date.now();
      addLog('AutoPilot step failed: ' + error.message + '. The watchdog will try again.', 'warn');
    }
  } finally {
    isRunningAutonomousStep = false;
  }
}

async function handleVideoEnded(currentPath, currentLessonIndex, mode = 'pending_only') {
  if (!isBulkActive || !autoNavigateEnabled) return;
  log('Video ended. Waiting for LinkedIn to award green checkmark...');
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isBulkActive || !autoNavigateEnabled) return;
    expandAllSections();
    const syllabus = getCourseSyllabus();
    const curr = syllabus.find((l) => {
      const h = (l.href || '').toLowerCase();
      return h.includes(currentPath) || currentPath.includes(h);
    });
    if (curr && curr.completed) {
      log('Video green checkmark registered!');
      break;
    }
  }

  expandAllSections();
  const updatedSyllabus = getCourseSyllabus();
  const endedLesson = updatedSyllabus.find(l => l.href === currentPath);
  if (strictCompletionEnabled && !endedLesson?.completed) {
    showHUD('Waiting for LinkedIn to mark this lesson Viewed.', 'warn');
    return;
  }
  await advanceToNextItem(updatedSyllabus, currentLessonIndex, mode);
}

async function advanceToNextItem(syllabus, currentIdx = -1, mode = 'pending_only') {
  if (!isBulkActive || !autoNavigateEnabled) return;
  if (!syllabus || syllabus.length === 0) return;
  const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();

  const isEligible = (l) => {
    if (l.completed) return false;
    if (mode === 'videos_only') return l.isVideo;
    if (mode === 'quizzes_only') return l.isQuiz;
    return true; // 'all' or 'pending_only'
  };

  // Always resolve the earliest outstanding item, including gaps behind us.
  const nextItem = syllabus.find(l => isEligible(l) && l.href.toLowerCase() !== currentPath);

  // 3. If none left, course finished
  const remaining = syllabus.filter(isEligible);
  if (remaining.length === 0) {
    log(`🎉 All eligible items completed for mode: ${mode}`);
    const targetCount = syllabus.filter((l) => {
      if (mode === 'videos_only') return l.isVideo;
      if (mode === 'quizzes_only') return l.isQuiz;
      return true;
    }).length;

    await addLog(`🎉 AutoPilot finished! All ${targetCount} items completed (${mode}).`, 'success');

    // If we're in a Learning Path workflow, return to path page instead of stopping
    const pathReturned = await finishCourseAndReturnToPath();
    if (pathReturned) {
      // Keep isBulkActive = true so AutoPilot continues on the next course
      return;
    }

    // Not in a learning path — stop AutoPilot
    isBulkActive = false;
    await chrome.storage.local.set({ bulkActive: false });

    sendProgress({
      message: `🎉 All items completed! (${targetCount}/${targetCount} verified).`,
      percent: 100,
      current: targetCount,
      total: targetCount,
      isDone: true,
      isRunning: false
    });
    applySpeed(videoEl, 1);
    return;
  }

  if (nextItem) {
    navigateToLesson(nextItem);
  } else if (remaining[0]) {
    navigateToLesson(remaining[0]);
  }
}

async function advanceToNextUncompletedVideo(syllabus, currentIdx = -1) {
  return advanceToNextItem(syllabus, currentIdx, 'videos_only');
}

function navigateToLesson(lesson, {allowAutoplay = false} = {}) {
  const epoch = quizRunEpoch;
  const allowed = () => epoch === quizRunEpoch && !quizAutoPaused && autoNavigateEnabled &&
    !isDiscoveringPathQueue && (isBulkActive || (allowAutoplay && autoplayEnabled));
  if (!allowed() || !lesson) return false;
  const targetUrl = lesson.fullHref || lesson.href;
  if (!targetUrl) return false;

  // Block any accidental navigation to certificates
  if (/\b(?:certificates?|sertifikat)\b/i.test(targetUrl)) {
    log('Blocked navigation to certificates link! Returning to learning path instead...');
    returnToLearningPath({allowAutoplay});
    return false;
  }

  log('Navigating to lesson:', lesson.title, '->', targetUrl);
  isNavigatingToLesson = true;

  if (navWatchdogTimer) clearTimeout(navWatchdogTimer);
  navWatchdogTimer = setTimeout(() => {
    isNavigatingToLesson = false;
    const currentClean = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
    const targetClean = lesson.href.split('?')[0].split('#')[0].toLowerCase();
    if (allowed() && currentClean !== targetClean) {
      log('Navigation timeout. Forcing window.location:', targetUrl);
      window.location.href = targetUrl;
    }
  }, 4000);

  try {
    if (lesson.element && lesson.element.isConnected) {
      lesson.element.click();
    } else {
      window.location.href = targetUrl;
    }
  } catch (e) {
    window.location.href = targetUrl;
  }
  return true;
}

// ─── Playback Engine & Anti-Freeze ────────────────────────────────────────────

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'LI_BACKGROUND_PLAY_BLOCKED' || !backgroundRun) return;
  const message = 'Background playback was blocked by the browser. Open the tab and press Play once.';
  showHUD(message, 'warn');
  sendProgress({ message });
});

function syncPlaybackSettings() {
  syncAutomationPlaybackState();
  window.postMessage({ type: 'LI_FORCE_SPEED', speed: currentSpeed, enabled: speedInjectionEnabled }, window.location.origin);
  window.postMessage({ type: 'LI_SET_BACKGROUND_PLAY', enabled: backgroundRun }, window.location.origin);
}

function applySpeed(video, speed) {
  if (!video) return;

  lastRateChangeTime = Date.now();

  // Forward to MAIN world Native Speed Engine in page-inject.js
  try {
    window.postMessage({
      type: 'LI_FORCE_SPEED',
      speed: speed,
      enabled: speedInjectionEnabled
    }, window.location.origin);
  } catch (e) {}

  try {
    video.playbackRate = speedInjectionEnabled ? speed : 1;
  } catch (err) {}

  if (!isBulkActive) {
    try {
      chrome.runtime.sendMessage({ action: 'updateBadge', text: `${speed}x` });
    } catch (e) {}
  }
}

function fastForwardToEnd() {
  if (!videoEl || !isFinite(videoEl.duration) || videoEl.duration <= 0) return false;
  videoEl.currentTime = Math.max(0, videoEl.duration - 0.3);
  videoEl.playbackRate = 2;
  videoEl.play().catch(() => {});
  return true;
}

function seekRelative(seconds) {
  if (!videoEl || !isFinite(videoEl.duration)) return;
  const target = Math.max(0, Math.min(videoEl.duration - 0.5, videoEl.currentTime + seconds));
  videoEl.currentTime = target;
  if (videoEl.paused) videoEl.play().catch(() => {});
}

// ─── Next Lesson Navigation ───────────────────────────────────────────────────

function goToNextLesson() {
  const playerSelectors = [
    '.classroom-video-player button[data-control-name="next_video"]',
    '.classroom-video-player button[data-control-name="continue"]',
    '.classroom-video-player button[aria-label="Go to next video"]',
    '.classroom-video-player button[aria-label="Next video"]',
    '.classroom-video-player button[aria-label="Continue to next lesson"]',
    '.classroom-next-button',
    '.continue-button',
    '[data-test="next-section-button"]'
  ];

  for (const sel of playerSelectors) {
    const btn = document.querySelector(sel);
    if (btn && !isLanguageElement(btn) && !btn.disabled && btn.offsetParent !== null) {
      const t = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
      if (!/\b(?:certificate|certificates|sertifikat)\b/i.test(t)) {
        btn.click();
        return true;
      }
    }
  }

  try {
    // STRICTLY search within the syllabus sidebar TOC! Never query whole document!
    const sidebar = document.querySelector('.classroom-layout-sidebar-body, .classroom-layout__sidebar-body, .classroom-body__sidebar-body, #course-contents, .classroom-toc');
    if (!sidebar) {
      returnToLearningPath({ allowAutoplay: true });
      return false;
    }

    const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
    const tocLinks = Array.from(sidebar.querySelectorAll('a[href*="/learning/"]'))
      .filter((a) => {
        const href = (a.getAttribute('href') || a.href || '').toLowerCase();
        const text = (a.innerText || '').trim().toLowerCase();
        if (/\b(?:certificate|certificates|sertifikat|cert|exercise|overview|transcript|notebook|review|share)\b/i.test(href + ' ' + text)) {
          return false;
        }
        return true;
      });

    const currentIndex = tocLinks.findIndex((a) => {
      const href = (a.getAttribute('href') || a.href || '').toLowerCase();
      return href.includes(currentPath) || a.classList.contains('active') || a.getAttribute('aria-current') === 'page';
    });

    if (currentIndex !== -1 && currentIndex + 1 < tocLinks.length) {
      tocLinks[currentIndex + 1].click();
      return true;
    } else if (currentIndex !== -1 && currentIndex + 1 >= tocLinks.length) {
      log('Reached end of course syllabus in goToNextLesson. Returning to learning path...');
      returnToLearningPath({ allowAutoplay: true });
      return true;
    }
  } catch (e) {}

  return false;
}

// ─── Watchdog Supervisor ──────────────────────────────────────────────────────

let backgroundRegistration = null;
let backgroundRegisteredAt = -Infinity;
let lastAutomationPlaybackState = null;
function syncAutomationPlaybackState() {
  const enabled = !quizAutoPaused && (isBulkActive || autoplayEnabled);
  if (enabled === lastAutomationPlaybackState) return;
  lastAutomationPlaybackState = enabled;
  window.postMessage({type:'LI_SET_AUTOPLAY_STATE', enabled}, window.location.origin);
}
function shouldSuperviseBackgroundRun() {
  return backgroundRun && !quizAutoPaused &&
    (isBulkActive || isDiscoveringPathQueue || isSolvingQuiz || isQuizWorkflowRunning ||
      (autoplayEnabled && autoNavigateEnabled));
}
function syncBackgroundSupervision() {
  syncAutomationPlaybackState();
  const enabled = !!shouldSuperviseBackgroundRun();
  if (enabled === backgroundRegistration && (!enabled || Date.now() - backgroundRegisteredAt < 60000)) return;
  backgroundRegistration = enabled;
  backgroundRegisteredAt = Date.now();
  try {
    chrome.runtime.sendMessage({action:'backgroundRunState', enabled}, response => {
      if (chrome.runtime.lastError || response?.success === false) backgroundRegistration = null;
    });
  } catch (_) { backgroundRegistration = null; }
}

function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);

  watchdogInterval = setInterval(runPlaybackWatchdog, 500);
}

function runPlaybackWatchdog() {
    syncBackgroundSupervision();
    if (recoverBlockedPlayback()) return;
    const currentVideo = document.querySelector('video');
    if (videoEl && videoEl !== currentVideo) videoEl = null;
    if (currentVideo && currentVideo !== videoEl) attachToVideo(currentVideo);
    if (isDiscoveringPathQueue) return;
    // Playback recovery must continue even while a navigation/quiz step awaits a response.
    if (isBulkActive && videoEl && !isQuizOnPage() && videoEl.paused && !videoEl.ended) requestManagedPlayback(videoEl);
    // Handle player surveys during ordinary autoplay as well as AutoPilot.
    if (dismissSurveyIfPresent()) return;

    if (isBulkActive) {
      if (isRunningAutonomousStep || isNavigatingToLesson || isSolvingQuiz || isQuizWorkflowRunning) {
        return;
      }
      if (isGlobalNavPage()) {
        log('Watchdog: Detected on off-track global nav page. Escaping to Learning Path...');
        runAutonomousStep();
        return;
      }
      if (isLearningPathPage()) {
        runAutonomousStep();
        return;
      }
      if (isQuizOnPage() || !videoEl || videoEl.ended || videoEl.paused) {
        runAutonomousStep();
      }
      return;
    }

    if (isQuizOnPage()) {
      checkAndAutoSolveQuiz();
      return;
    }

    if (!videoEl) {
      if (isLearningPathPage()) return;
      const found = document.querySelector('video');
      if (found) {
        attachToVideo(found);
      } else {
        if (skipNonVideos && autoplayEnabled && autoNavigateEnabled &&
            !getCourseSyllabus().some(item => item.href === window.location.pathname && item.isVideo)) {
          if (!nonVideoTimer) {
            nonVideoTimer = setTimeout(() => {
              nonVideoTimer = null;
              if (skipNonVideos && autoplayEnabled && autoNavigateEnabled && !document.querySelector('video')) {
                goToNextLesson();
              }
            }, 4000);
          }
        }
      }
      return;
    }

    if (nonVideoTimer) {
      clearTimeout(nonVideoTimer);
      nonVideoTimer = null;
    }

    if (videoEl.ended) return;

    const activeTargetRate = isBulkActive ? (currentSpeed || 16) : currentSpeed;
    if (speedInjectionEnabled && Date.now() - lastRateChangeTime > 500) {
      if (videoEl.playbackRate !== activeTargetRate) {
        applySpeed(videoEl, activeTargetRate);
      }
    }


    const now = videoEl.currentTime;
    if (now === lastRecordedTime && !videoEl.paused) {
      stuckCount++;
      if (stuckCount >= 3) {
        stuckCount = 0;
        try {
          videoEl.currentTime = Math.min(videoEl.duration - 0.1, videoEl.currentTime + 0.3);
          requestManagedPlayback(videoEl);
        } catch (e) {}
      }
    } else {
      stuckCount = 0;
      lastRecordedTime = now;
    }

    if (videoEl.paused && !videoEl.ended && isBulkActive && (backgroundRun || !document.hidden)) {
      if (videoEl.readyState >= 2) {
        requestManagedPlayback(videoEl);
      }
    }
}

// ─── Video Attachment ─────────────────────────────────────────────────────────

let _listenerController = null;

function attachToVideo(video) {
  if (isLearningPathPage()) return;
  if (video === videoEl) return;
  isNavigatingToLesson = false;

  if (_listenerController) {
    _listenerController.abort();
  }

  videoEl = video;
  _listenerController = new AbortController();
  const { signal } = _listenerController;

  const targetRate = isBulkActive ? (currentSpeed || 16) : currentSpeed;
  applySpeed(video, targetRate);
  startAudioKeepalive();

  video.addEventListener('ratechange', () => {
    if (!speedInjectionEnabled || Date.now() - lastRateChangeTime < 300) return;
    const rate = isBulkActive ? (currentSpeed || 16) : currentSpeed;
    if (speedInjectionEnabled && video.playbackRate !== rate) {
      applySpeed(video, rate);
    }
  }, { signal });

  video.addEventListener('ended', () => {
    if (isBulkActive) {
      runAutonomousStep();
      return;
    }
    if (!autoplayEnabled || !autoNavigateEnabled) return;
    setTimeout(() => {
      if (autoplayEnabled && autoNavigateEnabled && videoEl === video && video.ended && !isBulkActive) goToNextLesson();
    }, 800);
  }, { signal });

  const resumeReadyVideo = () => {
    if (videoEl === video && video.paused && !video.ended && (isBulkActive || autoplayEnabled)) requestManagedPlayback(video);
  };
  video.addEventListener('canplay', resumeReadyVideo, {signal});
  video.addEventListener('loadeddata', resumeReadyVideo, {signal});
  video.addEventListener('loadedmetadata', resumeReadyVideo, {signal});
  if (isBulkActive) resumeReadyVideo();

  startWatchdog();
}

// ─── DOM Observer ─────────────────────────────────────────────────────────────

function startObserver() {
  const tryFind = () => {
    if (isDiscoveringPathQueue) return;
    if (dismissSurveyIfPresent()) return;
    if (!isBulkActive) checkAndAutoSolveQuiz();
    if (videoEl && !videoEl.isConnected) {
      if (_listenerController) _listenerController.abort();
      videoEl = null;
    }
    if (isLearningPathPage()) return;
    const v = document.querySelector('video');
    if (v && v !== videoEl) attachToVideo(v);
  };

  tryFind();

  const observer = new MutationObserver(tryFind);
  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── SPA Navigation Monitor (Non-Invasive) ───────────────────────────────────

let lastMonitoredUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastMonitoredUrl) {
    lastMonitoredUrl = window.location.href;
    rememberLearningPath();
    quizError = null; quizErrorUrl = null; lastQuizCheckTime = 0;
    if (quizAutoTriggerTimer) clearTimeout(quizAutoTriggerTimer);
    quizAutoTriggerTimer = null;
    log('SPA Navigation detected:', lastMonitoredUrl);
    isNavigatingToLesson = false;
    if (navWatchdogTimer) {
      clearTimeout(navWatchdogTimer);
      navWatchdogTimer = null;
    }
    setTimeout(() => {
      if (isBulkActive) {
        runAutonomousStep();
      } else {
        checkAndAutoSolveQuiz();
      }
    }, 1500);
  }
}, 1000);

// ─── Initialization & Persistence ─────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get([
    'bulkActive',
    'pathQueueDiscoveryActive',
    'speedInjection',
    'bgPlay',
    'backgroundRun',
    'autoNavigate',
    'speed',
    'playbackSpeed',
    'autoplay',
    'skipNonVideos',
    'autoSolveQuizzes',
    'autoSolve',
    'focusMode',
    'strictCompletion',
    'learningPathActive',
    'lastLearningPathUrl'
  ]);

  if (stored) {
    speedInjectionEnabled = stored.speedInjection !== false;
    backgroundRun = stored.bgPlay !== undefined ? !!stored.bgPlay : stored.backgroundRun !== false;
    autoNavigateEnabled = stored.autoNavigate !== false;
    if (typeof stored.playbackSpeed === 'number') currentSpeed = stored.playbackSpeed;
    else if (typeof stored.speed === 'number') currentSpeed = stored.speed;
    currentSpeed = Math.min(16, Math.max(0.25, Number(currentSpeed) || 1));
    if (stored.focusMode) focusMode = stored.focusMode;
    if (stored.strictCompletion !== undefined) strictCompletionEnabled = !!stored.strictCompletion;
    if (typeof stored.autoplay === 'boolean') autoplayEnabled = stored.autoplay;
    if (typeof stored.skipNonVideos === 'boolean') skipNonVideos = stored.skipNonVideos;
    if (typeof stored.autoSolve === 'boolean') autoSolveQuizzes = stored.autoSolve;
    else if (typeof stored.autoSolveQuizzes === 'boolean') autoSolveQuizzes = stored.autoSolveQuizzes;

    try {
      window.postMessage({
        type: 'LI_FORCE_SPEED',
        speed: currentSpeed,
        enabled: stored.speedInjection !== false
      }, '*');
    } catch (e) {}

    // Restore learning path state
    if (stored.learningPathActive) learningPathActive = true;
    if (stored.lastLearningPathUrl) lastLearningPathUrl = stored.lastLearningPathUrl;

    if (window.location.href.includes('/paths/')) {
      learningPathActive = true;
      lastLearningPathUrl = window.location.href;
      chrome.storage.local.set({
        learningPathActive: true,
        lastLearningPathUrl: window.location.href
      });
    }

    if (stored.bulkActive === true && !stored.pathQueueDiscoveryActive) {
      log('Resuming autonomous bulk course completion...');
      if (learningPathActive) {
        log('Learning Path mode active. Path URL:', lastLearningPathUrl);
      }
      isBulkActive = true;
      if (isGlobalNavPage()) {
        log('Init: On off-track global nav page with bulkActive=true. Escaping immediately...');
        setTimeout(() => { returnToLearningPath(); }, 400);
      }
      setTimeout(runAutonomousStep, 1000);
    }
  }
  syncPlaybackSettings();
  const restoredVideo = document.querySelector('video');
  if (restoredVideo && isBulkActive) { attachToVideo(restoredVideo); requestManagedPlayback(restoredVideo); }
  rememberLearningPath();
  if (stored.pathQueueDiscoveryActive) {
    isDiscoveringPathQueue = true;
    const discoveryEpoch = quizRunEpoch;
    setTimeout(() => {
      if (isDiscoveringPathQueue && !quizAutoPaused && discoveryEpoch === quizRunEpoch) return startAllPaths({resumeDiscovery:true});
    }, 500);
  }
  if (document.body) {
    startObserver();
    startWatchdog();
    setTimeout(checkAndAutoSolveQuiz, 1200);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      startObserver();
      startWatchdog();
      setTimeout(checkAndAutoSolveQuiz, 1200);
    });
  }

  window.addEventListener('click', startAudioKeepalive, { once: true });

}

init();

function getVisibleLearningPaths() {
  const seen = new Set();
  const links = [
    ...document.querySelectorAll('main h3 a[href*="/learning/paths/"]'),
    ...document.querySelectorAll('main h2 a[href*="/learning/paths/"], main h4 a[href*="/learning/paths/"]'),
    ...document.querySelectorAll('main a[href*="/learning/paths/"]')
  ];
  return links.flatMap(link => {
    const url = validLearningPathUrl(link.getAttribute('href') || link.href);
    if (!url || seen.has(new URL(url).pathname)) return [];
    seen.add(new URL(url).pathname);
    return [{title: (link.textContent || link.getAttribute('aria-label') || '').trim(), url, completed:false}];
  });
}

function librarySectionUrl(raw) {
  try {
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin &&
      /^\/learning\/me\/my-library\/(?:in-progress|saved|assigned|recommended)\/?$/.test(url.pathname) ? url.href : null;
  } catch (e) { return null; }
}

function libraryItemCount() {
  return document.querySelectorAll('main h3 a').length || document.querySelectorAll('main h2 a, main h4 a').length;
}

async function startAllPaths({resumeDiscovery = false} = {}) {
  if (!autoNavigateEnabled) {
    if (resumeDiscovery) { isDiscoveringPathQueue = false; await chrome.storage.local.set({pathQueueDiscoveryActive:false}); }
    return {success:false, error:'Enable Auto-navigation before starting the path queue.'};
  }
  if (isDiscoveringPathQueue && !resumeDiscovery) return {success:true, discovering:true, message:'Path discovery is already running.'};
  const epoch = ++quizRunEpoch;
  isDiscoveringPathQueue = true;
  isBulkActive = false;
  quizAutoPaused = false;
  quizError = null; quizErrorUrl = null;
  if (navWatchdogTimer) clearTimeout(navWatchdogTimer);
  navWatchdogTimer = null; isNavigatingToLesson = false;
  const active = () => epoch === quizRunEpoch && isDiscoveringPathQueue && !quizAutoPaused && autoNavigateEnabled;
  const redirect = url => setTimeout(() => {
    if (epoch === quizRunEpoch && !quizAutoPaused && autoNavigateEnabled) window.location.href = url;
  }, 150);
  try {
    const stored = await chrome.storage.local.get(['pathQueueDiscovery', 'pathQueueRunId']);
    if (!active()) return {success:false, error:'Path discovery cancelled.'};
    const discovery = resumeDiscovery && stored.pathQueueDiscovery ? stored.pathQueueDiscovery : {sections:[], visited:[], paths:[]};
    await chrome.storage.local.set({bulkActive:false, pathQueueActive:false, pathQueueDiscoveryActive:true});
    if (!active()) return {success:false, error:'Path discovery cancelled.'};
    const currentSection = librarySectionUrl(window.location.href);
    if (!currentSection) {
      const library = new URL('/learning/me/my-library/in-progress', window.location.href);
      const org = new URL(window.location.href).searchParams.get('u');
      if (org) library.searchParams.set('u', org);
      discovery.sections = [library.href];
      await chrome.storage.local.set({pathQueueDiscovery:discovery});
      if (!active()) return {success:false, error:'Path discovery cancelled.'};
      redirect(library.href);
      return {success:true, discovering:true, message:'Opening My Content to collect learning paths...'};
    }
    for (let wait = 0; wait < 25 && !libraryItemCount() && !getVisibleLearningPaths().length; wait++) {
      const text = document.querySelector('main')?.innerText || document.body?.innerText || '';
      if (/don.t have|no (?:saved|in progress|recommended|assigned|outstanding)|nothing (?:saved|here)|no content/i.test(text)) break;
      await new Promise(r => setTimeout(r, 200));
      if (!active()) return {success:false, error:'Path discovery cancelled.'};
      if (wait === 24) throw new Error('My Content is still loading. Wait for the list, then start All Paths again.');
    }
    const sections = [currentSection, ...Array.from(document.querySelectorAll('a[href*="/learning/me/my-library/"]'))
      .map(link => librarySectionUrl(link.getAttribute('href') || link.href)).filter(Boolean)];
    for (const url of sections) {
      if (!discovery.sections.some(existing => new URL(existing).pathname === new URL(url).pathname)) discovery.sections.push(url);
    }
    for (let page = 0; page < 30; page++) {
      const more = Array.from(document.querySelectorAll('main button')).find(button =>
        /show more.*(?:in[-\s]+progress|assigned|recommended|saved).*content/i.test(button.getAttribute('aria-label') || '') ||
        /^show more$/i.test((button.innerText || '').trim()));
      if (!more) break;
      for (let wait = 0; wait < 20 && !isElementClickable(more); wait++) {
        await new Promise(r => setTimeout(r, 200));
        if (!active()) return {success:false, error:'Path discovery cancelled.'};
      }
      if (!isElementClickable(more)) throw new Error('Show more is unavailable. Wait for My Content to finish loading, then retry.');
      const count = libraryItemCount(); more.click();
      for (let wait = 0; wait < 20 && libraryItemCount() <= count; wait++) {
        await new Promise(r => setTimeout(r, 200));
        if (!active()) return {success:false, error:'Path discovery cancelled.'};
      }
      if (libraryItemCount() <= count) throw new Error('Show more did not finish loading. Try All Paths again after the list loads.');
      if (page === 29) throw new Error('Load the remaining content before starting this large queue.');
    }
    for (const path of getVisibleLearningPaths()) {
      if (!discovery.paths.some(existing => new URL(existing.url).pathname === new URL(path.url).pathname)) discovery.paths.push(path);
    }
    const currentPath = new URL(currentSection).pathname;
    if (!discovery.visited.includes(currentPath)) discovery.visited.push(currentPath);
    const nextSection = discovery.sections.find(url => !discovery.visited.includes(new URL(url).pathname));
    if (nextSection) {
      await chrome.storage.local.set({pathQueueDiscovery:discovery});
      if (!active()) return {success:false, error:'Path discovery cancelled.'};
      redirect(nextSection);
      return {success:true, discovering:true, totalPaths:discovery.paths.length, message:'Found ' + discovery.paths.length + ' paths. Checking the next My Content section...'};
    }
    if (!discovery.paths.length) throw new Error('No learning paths were found in your available My Content lists.');
    if (!active()) return {success:false, error:'Path discovery cancelled.'};
    const paths = discovery.paths;
    await chrome.storage.local.set({pathQueue:paths, pathQueueIndex:0, pathQueueActive:true,
      pathQueueRunId:(stored.pathQueueRunId || 0) + 1, pathQueueDiscoveryActive:false, pathQueueDiscovery:null,
      bulkActive:true, learningPathActive:true, lastLearningPathUrl:paths[0].url, focusMode:'pending_only'});
    if (!active()) return {success:false, error:'Path discovery cancelled.'};
    await addLog('Queued ' + paths.length + ' learning paths from My Content.', 'success');
    redirect(paths[0].url);
    return {success:true, totalPaths:paths.length};
  } catch (error) {
    if (epoch === quizRunEpoch) await chrome.storage.local.set({pathQueueDiscoveryActive:false, bulkActive:false});
    await addLog(error.message, 'error');
    sendProgress({error:true, message:error.message});
    return {success:false, error:error.message};
  } finally { isDiscoveringPathQueue = false; }
}

async function advancePathQueue() {
  const { pathQueueActive, pathQueue = [], pathQueueIndex = 0 } = await chrome.storage.local.get(['pathQueueActive', 'pathQueue', 'pathQueueIndex']);
  if (!pathQueueActive || !isBulkActive || !autoNavigateEnabled) return false;
  const current = pathQueue[pathQueueIndex];
  if (!current || new URL(current.url).pathname !== window.location.pathname) return false;
  current.completed = true;
  const nextIndex = pathQueueIndex + 1;
  const next = pathQueue[nextIndex];
  await chrome.storage.local.set({ pathQueue, pathQueueIndex: nextIndex, pathQueueActive: !!next });
  if (!next || !isBulkActive || !autoNavigateEnabled) return false;
  await chrome.storage.local.set({ learningPathActive: true, lastLearningPathUrl: next.url, bulkActive: true });
  if (!isBulkActive) return false;
  window.location.href = next.url;
  return true;
}

// ─── Messaging (Popup ↔ Content) ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'backgroundPulse') {
    const active = !!shouldSuperviseBackgroundRun();
    // Reply immediately: a stalled recovery action must not block supervision.
    sendResponse({active});
    if (active) {
      window.postMessage({type:'LI_BACKGROUND_PULSE'}, window.location.origin);
      try { runPlaybackWatchdog(); }
      catch (error) { addLog('Background watchdog failed: ' + error.message, 'warn'); }
    }
    return true;
  }
  if (message.action === 'startAllPaths') {
    startAllPaths().then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'startBulkComplete') {
    resetNetworkCompletionSignals();
    quizRunEpoch++;
    isDiscoveringPathQueue = false;
    if (message.focusMode) focusMode = message.focusMode;
    if (message.speed) currentSpeed = Math.min(16, Math.max(0.25, parseFloat(message.speed) || currentSpeed));
    isBulkActive = true;
    quizError = null; quizErrorUrl = null; quizAutoPaused = false;
    continuedQuizUrls.clear();
    rememberLearningPath();
    if (window.location.href.includes('/paths/')) {
      learningPathActive = true;
      lastLearningPathUrl = window.location.href;
      chrome.storage.local.set({
        learningPathActive: true,
        lastLearningPathUrl: window.location.href
      });
    }
    chrome.storage.local.set({ bulkActive: true, pathQueueActive: false, pathQueueDiscoveryActive: false, pathQueueDiscovery: null, focusMode, playbackSpeed: currentSpeed });
    addLog(`🚀 AutoPilot started (Focus Mode: ${focusMode}, Speed: ${currentSpeed}x)`, 'info');
    syncBackgroundSupervision();
    runAutonomousStep();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'stopBulkComplete') {
    resetNetworkCompletionSignals();
    quizRunEpoch++;
    quizAutoPaused = true;
    isDiscoveringPathQueue = false;
    if (quizAutoTriggerTimer) clearTimeout(quizAutoTriggerTimer);
    quizAutoTriggerTimer = null;
    isBulkActive = false;
    learningPathActive = false;
    lastLearningPathUrl = null;
    chrome.storage.local.set({ bulkActive: false, pathQueueActive: false, pathQueueDiscoveryActive: false, pathQueueDiscovery: null, learningPathActive: false, lastLearningPathUrl: null, pathExamNotice: null });
    if (nonVideoTimer) clearTimeout(nonVideoTimer);
    nonVideoTimer = null;
    if (navWatchdogTimer) clearTimeout(navWatchdogTimer);
    navWatchdogTimer = null;
    isNavigatingToLesson = false;
    syncPlaybackSettings();
    chrome.runtime.sendMessage({ action: 'updateBadge', text: '' });
    syncBackgroundSupervision();
    addLog('⏹ AutoPilot stopped by user.', 'info');
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'setFocusMode') {
    focusMode = message.focusMode || 'pending_only';
    chrome.storage.local.set({ focusMode });
    addLog(`Focus Mode set to: ${focusMode}`, 'info');
    sendResponse({ success: true, focusMode });
    return true;
  }

  if (message.action === 'setStrictCompletion') {
    strictCompletionEnabled = !!message.enabled;
    chrome.storage.local.set({ strictCompletion: strictCompletionEnabled });
    sendResponse({ success: true, strictCompletion: strictCompletionEnabled });
    return true;
  }

  if (message.action === 'setBgPlay') {
    backgroundRun = !!message.enabled;
    chrome.storage.local.set({ bgPlay: backgroundRun });
    syncBackgroundSupervision();
    syncPlaybackSettings();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'setAutoNavigate') {
    autoNavigateEnabled = !!message.enabled;
    chrome.storage.local.set({ autoNavigate: autoNavigateEnabled });
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'setSpeedInjection') {
    speedInjectionEnabled = !!message.enabled;
    chrome.storage.local.set({ speedInjection: speedInjectionEnabled });
    syncPlaybackSettings();
    if (speedInjectionEnabled) applySpeed(videoEl, currentSpeed);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'solveQuizNow') {
    quizAutoPaused = false;
    if (!isQuizOnPage()) { sendResponse({success:false, error:'Open a chapter quiz first.'}); return true; }
    solveLinkedInQuizWithGreenTickRetry().then((res) => {
      sendResponse({ success: res, error: res ? undefined : (quizError || 'Quiz completion could not be verified. Check the quiz and Activity Log.') });
    });
    return true;
  }

  if (message.action === 'setSpeed') {
    const speed = parseFloat(message.speed);
    if (!isFinite(speed) || speed <= 0) {
      sendResponse({ success: false, error: 'Invalid speed.' });
      return true;
    }
    currentSpeed = Math.min(16, Math.max(0.25, speed));
    applySpeed(videoEl, currentSpeed);
    chrome.runtime.sendMessage({ action: 'setStorage', data: { speed: currentSpeed, playbackSpeed: currentSpeed } });
    sendResponse({ success: true, speed: currentSpeed, isMuted: videoEl ? videoEl.muted : false });
    return true;
  }

  if (message.action === 'setAutoplay') {
    autoplayEnabled = !!message.enabled;
    chrome.runtime.sendMessage({ action: 'setStorage', data: { autoplay: autoplayEnabled } });
    sendResponse({ success: true, autoplay: autoplayEnabled });
    return true;
  }

  if (message.action === 'setAutoSolveQuizzes') {
    autoSolveQuizzes = !!message.enabled;
    chrome.storage.local.set({ autoSolve: autoSolveQuizzes, autoSolveQuizzes });
    if (autoSolveQuizzes) { quizAutoPaused = false; quizError = null; quizErrorUrl = null; lastQuizCheckTime = 0; checkAndAutoSolveQuiz(); }
    sendResponse({ success: true, autoSolveQuizzes });
    return true;
  }

  if (message.action === 'setSkipNonVideos') {
    skipNonVideos = !!message.enabled;
    chrome.runtime.sendMessage({ action: 'setStorage', data: { skipNonVideos } });
    sendResponse({ success: true, skipNonVideos });
    return true;
  }

  if (message.action === 'getState') {
    const syllabus = getCourseSyllabus();
    const total = syllabus.length;
    const completedCount = syllabus.filter((l) => l.completed).length;

    sendResponse({
      speed: currentSpeed,
      autoplay: autoplayEnabled,
      skipNonVideos,
      autoSolveQuizzes,
      focusMode,
      strictCompletion: strictCompletionEnabled,
      isBulkRunning: isBulkActive,
      isQuizPresent: isQuizOnPage(),
      completedCount,
      totalCount: total,
      hasVideo: !!videoEl,
      isPaused: videoEl ? videoEl.paused : true,
      currentTime: videoEl ? Math.round(videoEl.currentTime) : 0,
      duration: videoEl && isFinite(videoEl.duration) ? Math.round(videoEl.duration) : 0,
      isMuted: videoEl ? videoEl.muted : false,
      courseSlug: getCourseSlug()
    });
    return true;
  }

  if (message.action === 'nextLesson') {
    const ok = goToNextLesson();
    sendResponse({ success: ok });
    return true;
  }

  if (message.action === 'fastForwardToEnd') {
    const ok = fastForwardToEnd();
    sendResponse({ success: ok });
    return true;
  }

  if (message.action === 'seekRelative') {
    seekRelative(message.seconds || 0);
    sendResponse({ success: true });
    return true;
  }
});


// Apply popup settings to every open learning tab, including tabs restored later.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.speedInjection) speedInjectionEnabled = changes.speedInjection.newValue !== false;
  if (changes.playbackSpeed) currentSpeed = Math.min(16, Math.max(0.25, Number(changes.playbackSpeed.newValue) || 1));
  if (changes.bgPlay) backgroundRun = changes.bgPlay.newValue !== false;
  if (changes.autoNavigate) autoNavigateEnabled = changes.autoNavigate.newValue !== false;
  if (changes.autoplay) autoplayEnabled = changes.autoplay.newValue !== false;
  if (changes.skipNonVideos) skipNonVideos = changes.skipNonVideos.newValue !== false;
  if (changes.autoSolve || changes.autoSolveQuizzes) autoSolveQuizzes = (changes.autoSolve || changes.autoSolveQuizzes).newValue !== false;
  if (changes.focusMode) focusMode = changes.focusMode.newValue || 'pending_only';
  if (changes.strictCompletion) strictCompletionEnabled = changes.strictCompletion.newValue !== false;
  if (changes.bulkActive && changes.bulkActive.newValue === false) isBulkActive = false;
  if (changes.speedInjection || changes.playbackSpeed || changes.bgPlay || changes.autoplay) syncPlaybackSettings();
  if (changes.bgPlay || changes.bulkActive || changes.autoplay) syncBackgroundSupervision();
  const providerChanged = ['groqApiKey', 'geminiApiKey', 'openRouterApiKey', 'nvidiaApiKey', 'selectedProvider'].some(key => changes[key]);
  if (providerChanged || ((changes.autoSolve || changes.autoSolveQuizzes) && autoSolveQuizzes)) {
    quizAutoPaused = false; quizError = null; quizErrorUrl = null; lastQuizCheckTime = 0;
    checkAndAutoSolveQuiz();
  }
});
