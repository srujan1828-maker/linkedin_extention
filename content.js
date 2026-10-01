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
let skipNonVideos = true;
let autoSolveQuizzes = true;
let focusMode = 'pending_only';
let strictCompletionEnabled = true;
let isBulkActive = false;
let isSolvingQuiz = false;
let videoEl = null;
let watchdogInterval = null;
let lastRecordedTime = -1;
let stuckCount = 0;
let lastRateChangeTime = 0;
let previousMuteState = false;
let keepalivePort = null;
let keepaliveAudioCtx = null;
let nonVideoTimer = null;
let navWatchdogTimer = null;
let learningPathActive = false;
let lastLearningPathUrl = null;

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

connectKeepalivePort();

function startAudioKeepalive() {
  // Non-invasive no-op: background playback is maintained by Page Visibility spoofing in page-inject.js
}

// ─── Course & Syllabus Utilities ─────────────────────────────────────────────

let cachedCourseSlug = null;

function getCourseSlug() {
  const path = window.location.pathname;
  const match = path.match(/\/(?:learning|learning-career-hub|career-hub)\/([^/]+)/);
  if (match && match[1] !== 'paths' && match[1] !== 'learning-paths' && match[1] !== 'search' && match[1] !== 'me') {
    cachedCourseSlug = match[1];
    try { chrome.storage.local.set({ lastCourseSlug: cachedCourseSlug }); } catch (e) {}
    return cachedCourseSlug;
  }
  return cachedCourseSlug;
}

function isLanguageElement(el) {
  if (!el) return false;
  // Specific LinkedIn global language dropdowns and controls
  if (el.closest('.language-selector, #language-selector, [data-test-language-selector], [data-control-name*="language" i]')) return true;
  if (el.closest('[class*="language" i], [id*="language" i], [aria-label*="language" i], [aria-label*="bahasa" i]')) return true;
  // Global footer language selector container only (do not block assessment or quiz footers)
  if (el.closest('.global-footer-compact, .global-footer__language') || (el.closest('.global-footer') && !el.closest('main, [role="main"], .quiz-challenge, .classroom-body, [class*="assessment"]'))) return true;
  // Global LinkedIn primary navigation bar (do not block classroom nav or quiz headers)
  if (el.closest('.global-nav, nav[aria-label="Primary"]') && !el.closest('.classroom-nav, .classroom-layout')) return true;
  return false;
}

function expandAllSections() {
  const sidebar = document.querySelector('#course-contents, [class*="classroom-toc"], ul.classroom-toc');
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

  // Ignore bookmark buttons or actions
  const bookmarkButtons = Array.from(
    container.querySelectorAll('button[aria-label*="bookmark" i], .classroom-toc-item__bookmark, [data-test-icon*="bookmark"]')
  );
  const isInsideBookmark = (el) => {
    for (const b of bookmarkButtons) {
      if (b.contains(el)) return true;
    }
    return false;
  };

  // 1. Text checks (Multilingual: EN, ID, ES, FR, DE)
  const text = (container.innerText || '').toLowerCase();
  const completionRegex = /\b(?:completed|watched|passed|quiz passed|selesai|lulus|ditonton|completado|visto|aprobado|terminé|réussi|abgeschlossen|bestanden)\b/i;
  const negativeRegex = /\b(?:not completed|unwatched|not started|belum selesai|belum dimulai|no completado|non terminé)\b/i;

  if (completionRegex.test(text) && !negativeRegex.test(text)) {
    return true;
  }

  // 2. ARIA labels on container and all child elements (excluding bookmarks)
  const ariaEls = Array.from(container.querySelectorAll('[aria-label]')).filter((el) => !isInsideBookmark(el));
  const allAria = [
    container.getAttribute('aria-label') || '',
    ...ariaEls.map((el) => el.getAttribute('aria-label') || '')
  ].join(' ').toLowerCase();

  if (completionRegex.test(allAria) && !negativeRegex.test(allAria)) {
    return true;
  }

  // 3. Screen-reader hidden elements (excluding bookmarks)
  const hiddenElements = Array.from(container.querySelectorAll('.visually-hidden, [class*="hidden"], [class*="sr-only"]')).filter((el) => !isInsideBookmark(el));
  for (const h of hiddenElements) {
    const ht = (h.innerText || '').toLowerCase();
    if (completionRegex.test(ht) && !negativeRegex.test(ht)) return true;
  }

  // 4. Dedicated LinkedIn icon components (excluding bookmarks)
  const iconElements = Array.from(container.querySelectorAll('li-icon, [data-test-icon], [data-icon]')).filter((el) => !isInsideBookmark(el));
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
  const svgs = Array.from(container.querySelectorAll('svg')).filter((el) => !isInsideBookmark(el));
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
        /green|#10b981|#059669|#12884a|#00732f|#057642|#107c41|rgb\(1[0-9],|rgb\(0,\s*1[0-9]|rgb\(5,\s*118|rgb\(16,\s*124|rgb\(18,\s*136/i.test(val);

      if (isGreen(stroke) || isGreen(fill) || isGreen(color) || isGreen(cssFill) || isGreen(cssStroke)) {
        return true;
      }
    } catch (e) {}
  }

  // 6. CSS classes
  const cls = ((container.className || '') + ' ' + ((container.closest('li') || {}).className || '')).toLowerCase();
  if (/classroom-toc-item--completed|has-passed|status--completed/i.test(cls)) {
    return true;
  }

  return false;
}

function findButtonByText(pattern, includeDisabled = false) {
  const candidates = Array.from(document.querySelectorAll(
    'button, [role="button"], input[type="button"], input[type="submit"], a, [class*="btn"], [class*="button"]'
  ));
  return candidates.find((el) => {
    if (!includeDisabled && !isElementClickable(el)) return false;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    return pattern.test(text);
  });
}

function getCourseSyllabus() {
  const courseSlug = getCourseSlug();
  if (!courseSlug) return [];

  expandAllSections();

  const links = Array.from(document.querySelectorAll(
    `a[href*="/learning/${courseSlug}/"], a[href*="/learning-career-hub/${courseSlug}/"], a[href*="/career-hub/${courseSlug}/"]`
  ));
  const seen = new Set();
  const lessons = [];

  for (const a of links) {
    const rawHref = a.getAttribute('href') || a.href;
    const cleanHref = rawHref.split('?')[0].split('#')[0];

    if (cleanHref.endsWith(`/learning/${courseSlug}`) || cleanHref.endsWith(`/learning/${courseSlug}/`)) {
      continue;
    }

    if (!seen.has(cleanHref)) {
      seen.add(cleanHref);
      const rowContainer = a.closest('li') || a.parentElement || a;
      const completed = isLessonCompleted(rowContainer);
      const title = (a.innerText || '').trim().replace(/\s+/g, ' ') || 'Lesson';

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
        fullHref: rawHref,
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
function isLearningPathPage() {
  const path = window.location.pathname.toLowerCase();
  const href = window.location.href.toLowerCase();

  // Must be on a path-like URL
  const isPathUrl =
    path.includes('/paths/') ||
    path.includes('/learning-paths/') ||
    path.includes('/learning-career-hub/') ||
    path.includes('/career-hub/') ||
    href.includes('/paths/') ||
    href.includes('/learning-paths/');

  if (!isPathUrl) return false;

  // If there's an active video player, we're inside a course, not on path overview
  if (document.querySelector('video')) return false;

  // If there's a course syllabus sidebar, we're inside a course
  if (document.querySelector('#course-contents, [class*="classroom-toc"], ul.classroom-toc')) return false;

  // Check that there are course/video cards on the page
  const items = getLearningPathItems();
  return items.length > 0;
}

/**
 * Checks if a Learning Path item (course/video card) is completed.
 * Looks for completion badges, green progress bars, checkmarks, and ARIA labels.
 */
function isPathItemCompleted(container) {
  if (!container) return false;

  // 1. Green progress bar at 100% or with green styling
  const progressBars = container.querySelectorAll('[class*="progress"], [role="progressbar"]');
  for (const bar of progressBars) {
    const style = window.getComputedStyle(bar);
    const bgColor = (style.backgroundColor || '').toLowerCase();
    const width = style.width;
    // Green progress bar means completed
    if (/green|#10b981|#059669|#12884a|#00732f|#057642|rgb\(16,\s*185|rgb\(5,\s*150/i.test(bgColor)) {
      return true;
    }
  }

  // 2. Check for completion text in ARIA labels and visible text
  const allText = (container.innerText || '').toLowerCase();
  const allAria = Array.from(container.querySelectorAll('[aria-label]'))
    .map(el => (el.getAttribute('aria-label') || '').toLowerCase())
    .join(' ');
  const combined = allText + ' ' + allAria;

  if (/\b(?:completed|complete|passed|selesai|lulus|completado|terminé|abgeschlossen)\b/i.test(combined) &&
      !/\b(?:not completed|incomplete|belum selesai|no completado|non terminé)\b/i.test(combined)) {
    return true;
  }

  // 3. SVG checkmark badges (white check in colored circle overlay)
  const svgs = container.querySelectorAll('svg');
  for (const svg of svgs) {
    const iconName = (
      svg.getAttribute('data-test-icon') ||
      svg.getAttribute('name') ||
      svg.getAttribute('aria-label') ||
      svg.getAttribute('type') ||
      ''
    ).toLowerCase();
    if (iconName.includes('check') || iconName.includes('completed') || iconName.includes('success')) {
      return true;
    }
    // Check <use> tags
    const useTags = svg.querySelectorAll('use');
    for (const u of useTags) {
      const href = (u.getAttribute('href') || u.getAttribute('xlink:href') || '').toLowerCase();
      if (href.includes('check') || href.includes('completed')) return true;
    }
  }

  // 4. li-icon elements with check type
  const icons = container.querySelectorAll('li-icon, [data-test-icon], [data-icon]');
  for (const ic of icons) {
    const iconType = (
      ic.getAttribute('type') ||
      ic.getAttribute('data-test-icon') ||
      ic.getAttribute('data-icon') ||
      ''
    ).toLowerCase();
    if (iconType.includes('check') || iconType.includes('completed')) return true;
  }

  // 5. CSS classes indicating completion
  const cls = (container.className || '').toLowerCase();
  if (/completed|complete|passed|finished/i.test(cls)) return true;

  // 6. Check for a visible duration text with green/completed style
  // On LinkedIn path pages, completed items show time with a green bar underneath
  const timeElements = container.querySelectorAll('span, div, p');
  for (const el of timeElements) {
    const text = (el.innerText || '').trim();
    if (/^\d+h?\s*\d*m?\s*\d*s?$/i.test(text)) {
      // This looks like a duration, check its parent for green styling
      try {
        const parent = el.parentElement;
        if (parent) {
          const pStyle = window.getComputedStyle(parent);
          const pBg = (pStyle.backgroundColor || '').toLowerCase();
          if (/green|#10b981|#059669|#12884a|#057642/i.test(pBg)) return true;
        }
      } catch (e) {}
    }
  }

  return false;
}

/**
 * Extracts course/video items from a Learning Path overview page.
 * Returns array of { title, href, card, completed, type }
 */
function getLearningPathItems() {
  const items = [];
  const seen = new Set();

  // Strategy 1: Find all course/video links on path pages
  const links = Array.from(document.querySelectorAll(
    'a[href*="/learning/"], a[href*="/learning-career-hub/"], a[href*="/career-hub/"]'
  ));

  for (const a of links) {
    const href = (a.getAttribute('href') || a.href || '').split('?')[0].split('#')[0];

    // Skip if it's a path URL itself or a generic link
    if (!href || href.endsWith('/learning/') || href.endsWith('/learning-career-hub/')) continue;
    if (/\/paths\/|\/learning-paths\/|\/search/i.test(href)) continue;

    // Skip nav/footer links
    if (a.closest('.global-nav, .global-footer, nav[aria-label="Primary"], footer')) continue;

    // Deduplicate
    if (seen.has(href)) continue;
    seen.add(href);

    // Find the card/container for this link
    const card = a.closest('article, [class*="card"], [class*="item"], li, section, div[class*="path"]') || a.parentElement;

    // Get the title
    const titleEl = card.querySelector('h2, h3, h4, [class*="title"], [class*="name"]') || a;
    const title = (titleEl.innerText || a.innerText || '').trim().replace(/\s+/g, ' ') || 'Course';

    // Skip if title is too short/generic (navigation elements)
    if (title.length < 3) continue;

    // Determine type from context
    const cardText = (card.innerText || '').toLowerCase();
    const type = /\bvideo\b/i.test(cardText) && !/\bcourse\b/i.test(cardText) ? 'video' : 'course';

    // Check completion
    const completed = isPathItemCompleted(card);

    items.push({
      element: a,
      card,
      href,
      fullHref: a.href || href,
      title,
      completed,
      type
    });
  }

  return items;
}

/**
 * Finds the "BACK TO LEARNING PATH" button/link inside a course player page.
 */
function findBackToLearningPathButton() {
  // Check for explicit back-to-path links
  const allClickable = Array.from(document.querySelectorAll('a, button, [role="button"]'));
  for (const el of allClickable) {
    if (isLanguageElement(el)) continue;
    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const combined = text + ' ' + aria;

    if (/back to learning path|back to path|kembali ke jalur pembelajaran|kembali ke path/i.test(combined)) {
      if (isElementClickable(el)) return el;
    }
  }

  // Check sidebar top area for path return link
  const sidebar = document.querySelector('#course-contents, [class*="classroom-toc"]');
  if (sidebar) {
    const topLinks = sidebar.querySelectorAll('a');
    for (const link of topLinks) {
      const text = (link.innerText || '').trim().toLowerCase();
      if (/back to|kembali ke|← |↩/i.test(text) && /path|jalur/i.test(text)) {
        if (isElementClickable(link)) return link;
      }
    }
  }

  return null;
}

/**
 * Handles one step of Learning Path auto-navigation.
 * Called when we detect we're on a Learning Path overview page.
 * Finds the first uncompleted course and clicks into it.
 */
async function handleLearningPathStep() {
  const items = getLearningPathItems();
  if (items.length === 0) {
    log('Learning Path: No items found on page. Waiting...');
    showHUD('🔍 Scanning Learning Path...', 'info');
    setTimeout(runAutonomousStep, 2000);
    return;
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

  // Scroll to and click the course
  isNavigatingToLesson = true;

  if (navWatchdogTimer) clearTimeout(navWatchdogTimer);
  navWatchdogTimer = setTimeout(() => {
    isNavigatingToLesson = false;
    if (isBulkActive) {
      log('Learning Path: Navigation timeout. Forcing URL:', nextItem.fullHref);
      window.location.href = nextItem.fullHref;
    }
  }, 5000);

  try {
    if (nextItem.element && nextItem.element.isConnected) {
      nextItem.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 500));
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
async function returnToLearningPath() {
  const stored = await chrome.storage.local.get(['learningPathActive', 'lastLearningPathUrl']);
  if (!stored.learningPathActive || !stored.lastLearningPathUrl) return false;

  log('Course completed! Returning to Learning Path...');
  showHUD('🎉 Course completed! Returning to Learning Path...', 'success');
  await addLog('🎉 Course completed! Returning to Learning Path...', 'success');

  // Try to click the "Back to Learning Path" button first
  const backBtn = findBackToLearningPathButton();
  if (backBtn && isElementClickable(backBtn)) {
    log('Clicking "Back to Learning Path" button:', backBtn.innerText);
    clickElement(backBtn);
    await new Promise(r => setTimeout(r, 2500));
  } else {
    // Fall back to saved URL
    log('No "Back to Learning Path" button found. Navigating to saved URL:', stored.lastLearningPathUrl);
    window.location.href = stored.lastLearningPathUrl;
  }

  return true;
}

// ─── Survey / Feedback Overlay Dismissal ──────────────────────────────────────

/**
 * Detects and auto-dismisses LinkedIn Learning survey/feedback overlays
 * (e.g. "How confident are you that you learned valuable skills from this course?")
 * by clicking "Skip survey", "No thanks", "Dismiss", or similar dismiss buttons.
 * Returns true if a survey was found and dismissed.
 */
function dismissSurveyIfPresent() {
  // Check if a survey/feedback overlay is visible on the page
  const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
  const hasSurvey =
    /how confident are you/i.test(bodyText) ||
    /help us improve/i.test(bodyText) ||
    /skip survey/i.test(bodyText) ||
    /rate this course/i.test(bodyText) ||
    /rate your experience/i.test(bodyText) ||
    /provide feedback/i.test(bodyText) ||
    /would you recommend/i.test(bodyText) ||
    /not very confident.*very confident/i.test(bodyText);

  if (!hasSurvey) return false;

  // Try to find and click "Skip survey" or similar dismiss buttons
  const dismissPatterns = [
    /^skip survey$/i,
    /^skip$/i,
    /^no thanks$/i,
    /^dismiss$/i,
    /^close$/i,
    /^not now$/i,
    /^lewati survei$/i,        // Indonesian
    /^lewati$/i,
    /^omitir encuesta$/i,      // Spanish
    /^passer le sondage$/i,    // French
    /^umfrage überspringen$/i  // German
  ];

  const allClickable = Array.from(document.querySelectorAll(
    'button, a, [role="button"], span[tabindex], div[tabindex], [class*="skip"], [class*="dismiss"], [class*="close"]'
  ));

  for (const pattern of dismissPatterns) {
    for (const el of allClickable) {
      if (isLanguageElement(el)) continue;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
      if (pattern.test(text) && isElementClickable(el)) {
        log('Survey detected! Clicking:', text);
        showHUD('⏭️ Skipping survey...', 'info');
        clickElement(el);
        return true;
      }
    }
  }

  // Fallback: try clicking an X/close button on the overlay
  const closeButtons = document.querySelectorAll(
    '[aria-label*="close" i], [aria-label*="dismiss" i], [aria-label*="tutup" i], [data-test-modal-close], .modal-close, .artdeco-modal__dismiss'
  );
  for (const btn of closeButtons) {
    if (isLanguageElement(btn)) continue;
    // Only click if it's inside a survey/feedback context
    const parent = btn.closest('[class*="survey"], [class*="feedback"], [class*="modal"], [class*="overlay"], [role="dialog"]');
    if (parent && isElementClickable(btn)) {
      log('Survey overlay detected! Clicking close button.');
      showHUD('⏭️ Closing survey overlay...', 'info');
      clickElement(btn);
      return true;
    }
  }

  return false;
}

// ─── Progress Reporting ───────────────────────────────────────────────────────

function sendProgress(data) {
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
    return pattern.test(text);
  });
}

function clickElement(el) {
  if (!el || isLanguageElement(el)) return;
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
  } catch (e) {}

  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
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
  return !!el.closest(
    '#course-contents, [class*="toc"], [class*="syllabus"], [class*="sidebar"], nav, aside, [role="navigation"], li.classroom-toc-item, .classroom-layout__sidebar, .classroom-nav'
  );
}

function isQuizOnPage() {
  // RULE 1: If there is an HTML5 video element or video player container on page, it is 100% a VIDEO, NEVER a quiz!
  if (document.querySelector('video, .classroom-video-player, [data-test-video-player], .video-js, .classroom-layout__video-player')) {
    return false;
  }

  // RULE 2: Check URL pathname specifically for dedicated quiz or assessment routes
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

  // RULE 3: Career Hub / Assessment Page Text Indicators
  const bodyText = (document.body ? document.body.innerText : '');
  if (/learning career hub/i.test(bodyText) || /select (?:an|one)?\s*answer/i.test(bodyText)) {
    if (/(?:question|pertanyaan|pregunta|frage)\s+\d+\s+(?:of|dari|de|von|\/)\s+\d+/i.test(bodyText)) {
      return true;
    }
  }

  // RULE 4: Exclude the sidebar TOC completely! The sidebar lists all items in the course.
  const mainArea = document.querySelector('main, .classroom-layout__main, .classroom-body, [role="main"]');
  const searchRoot = mainArea || document.body;

  // RULE 5: Check for LinkedIn's dedicated quiz challenge containers strictly OUTSIDE sidebar
  const quizCard = searchRoot.querySelector('.quiz-challenge, [data-test-quiz], [class*="quiz-challenge"], .classroom-quiz');
  if (quizCard && !isInsideSidebar(quizCard)) {
    return true;
  }

  // RULE 6: Check for Question Counter strictly OUTSIDE the sidebar TOC!
  // E.g. "Question 1 of 8" or "Pertanyaan 1 dari 8"
  const counterSelectors = [
    '.quiz-challenge__counter',
    '[class*="question-counter"]',
    '.quiz-step-counter'
  ];
  for (const sel of counterSelectors) {
    const el = searchRoot.querySelector(sel);
    if (el && !isInsideSidebar(el)) {
      return true;
    }
  }

  // Check main area text for counter format (must NOT be inside sidebar)
  const candidateElements = Array.from(searchRoot.querySelectorAll('h1, h2, h3, p, span, div, legend')).filter((el) => {
    return !isInsideSidebar(el);
  });
  const hasCounter = candidateElements.some((el) => {
    const t = (el.innerText || '').trim();
    return /(?:question|pertanyaan|pregunta|frage)\s+\d+\s+(?:of|dari|de|von|\/)\s+\d+/i.test(t);
  });
  if (hasCounter) {
    return true;
  }

  // RULE 7: Check for Start Quiz / Resume Quiz button strictly OUTSIDE sidebar
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

  // RULE 8: Active sidebar item check ONLY IF it has NO video duration and has explicit quiz title
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
  return cleanFormulaText(text);
}

function isForbiddenQuizButton(b) {
  if (!b) return true;
  const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
  return /previous|return to course|kembali|sebelumnya/i.test(t);
}

function findQuizActionAdvanceButton() {
  // 1. Check for text matching Next, Submit, Submit and continue, Check answer, Continue
  const textBtn = findButtonByText(
    /^next$|^submit$|^next question$|submit and continue|check answer|^continue$|^lanjutkan$|^berikutnya$|^kirim$/i,
    true
  );
  if (textBtn && !isForbiddenQuizButton(textBtn)) return textBtn;

  // 2. Primary Artdeco button in bottom controls
  const primaryButtons = Array.from(document.querySelectorAll(
    'button.artdeco-button--primary, button[data-control-name*="next" i], button[data-control-name*="submit" i], button[class*="primary" i], button[class*="next" i], button[class*="submit" i]'
  )).filter((b) => {
    if (isInsideSidebar(b) || isLanguageElement(b) || isForbiddenQuizButton(b)) return false;
    return true;
  });
  if (primaryButtons.length > 0) {
    return primaryButtons[0];
  }

  // 3. Right-hand sibling of Previous
  const prevBtn = findButtonByText(/^previous$|^kembali$|^sebelumnya$/i, true);
  if (prevBtn && prevBtn.parentElement) {
    const siblings = Array.from(prevBtn.parentElement.querySelectorAll('button, a[role="button"]')).filter((b) => {
      return b !== prevBtn && !isLanguageElement(b) && !isInsideSidebar(b) && !isForbiddenQuizButton(b);
    });
    if (siblings.length > 0) {
      return siblings[siblings.length - 1];
    }
  }

  // 4. Fallback to Skip button if present
  const skipBtn = findButtonByText(/^skip$|^lewati$/i, true);
  if (skipBtn && !isForbiddenQuizButton(skipBtn)) return skipBtn;

  return null;
}

function parseCurrentQuizQuestion() {
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

  if (promptCandidates.length > 0) {
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

async function selectOption(option, shouldCheck = true) {
  if (!option) return false;

  const input = option.input || (option.target && option.target.tagName === 'INPUT' ? option.target : option.target?.querySelector('input'));
  let label = option.label || (input ? (input.closest('label') || (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null)) : null);
  const target = label || option.target || input;

  if (!target || isLanguageElement(target) || isInsideSidebar(target)) {
    return false;
  }

  try {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus();
  } catch (e) {}

  // 1. Dispatch clean pointer & mouse sequence (Coursera Completer standard)
  try {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    target.click();
  } catch (e) {}

  // 2. Also trigger click on any inner interactive child (button, input, label)
  const innerEl = target.querySelector('button, [role="button"], input, label');
  if (innerEl && innerEl !== target) {
    try { innerEl.click(); } catch (e) {}
  }

  // 3. Enforce underlying input state via prototype setter for React/Artdeco
  if (input) {
    if (input.checked !== shouldCheck) {
      try {
        const protoSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
        if (protoSetter) {
          protoSetter.call(input, shouldCheck);
        } else {
          input.checked = shouldCheck;
        }
      } catch (e) {
        input.checked = shouldCheck;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // 4. ARIA checked / pressed state
  if (target.hasAttribute && target.hasAttribute('role')) {
    try {
      target.setAttribute('aria-checked', shouldCheck ? 'true' : 'false');
      target.setAttribute('aria-pressed', shouldCheck ? 'true' : 'false');
    } catch (e) {}
  }

  await new Promise((r) => setTimeout(r, 200));

  // 5. Ensure Submit / Advance button becomes enabled
  const advanceBtn = findQuizActionAdvanceButton();
  if (advanceBtn) {
    try {
      advanceBtn.removeAttribute('disabled');
      advanceBtn.disabled = false;
      advanceBtn.setAttribute('aria-disabled', 'false');
    } catch (e) {}
  }

  return true;
}

async function selectOptionAndVerify(option) {
  return selectOption(option, true);
}

function resolveSingleChoiceOption(options, ans) {
  if (!options || options.length === 0) return { index: -1, reason: 'No options available' };
  const ansTexts = (ans.answerTexts || []).map((t) => (t || '').trim()).filter(Boolean);
  const ansIndices = ans.answerIndices || [];

  // TIER 1: Exact / Clean Formula Match
  for (const ansText of ansTexts) {
    const cleanAns = cleanFormulaText(ansText);
    const matchIdx = options.findIndex((o) => cleanFormulaText(o.text) === cleanAns);
    if (matchIdx !== -1) {
      return { index: matchIdx, reason: `Exact formula match: "${ansText}"` };
    }
  }

  // TIER 2: Numeric Equality Match (prevents float/integer discrepancies)
  for (const ansText of ansTexts) {
    if (isNumericString(ansText)) {
      const numAns = Number(ansText);
      const matchIdx = options.findIndex((o) => isNumericString(o.text) && Math.abs(Number(o.text) - numAns) < 1e-5);
      if (matchIdx !== -1) {
        return { index: matchIdx, reason: `Numeric equality match: ${numAns}` };
      }
    }
  }

  // TIER 3: Punctuation & Space Insensitive Match
  for (const ansText of ansTexts) {
    const strippedAns = stripAll(ansText);
    if (strippedAns.length >= 2) {
      const matchIdx = options.findIndex((o) => stripAll(o.text) === strippedAns);
      if (matchIdx !== -1) {
        return { index: matchIdx, reason: `Normalized match: "${ansText}"` };
      }
    }
  }

  // TIER 4: Verified Index Match
  if (ansIndices.length > 0) {
    const idx = ansIndices[0];
    if (options[idx]) {
      if (ansTexts.length === 0) {
        return { index: idx, reason: `Direct index [${idx}]` };
      }
      const optClean = stripAll(options[idx].text);
      const ansClean = stripAll(ansTexts[0]);
      if (optClean === ansClean || optClean.includes(ansClean) || ansClean.includes(optClean)) {
        return { index: idx, reason: `Verified index [${idx}] ("${options[idx].text}")` };
      }
    }
  }

  // TIER 5: Phrase / Substring Match for text (Non-numeric, length >= 3)
  for (const ansText of ansTexts) {
    const cleanAns = cleanFormulaText(ansText);
    if (!isNumericString(cleanAns) && cleanAns.length >= 3) {
      const matchIdx = options.findIndex((o) => {
        const optClean = cleanFormulaText(o.text);
        return !isNumericString(optClean) && (optClean.includes(cleanAns) || cleanAns.includes(optClean));
      });
      if (matchIdx !== -1) {
        return { index: matchIdx, reason: `Substring match: "${ansText}" in "${options[matchIdx].text}"` };
      }
    }
  }

  // TIER 6: Fallback to index if within bounds
  if (ansIndices.length > 0 && options[ansIndices[0]]) {
    return { index: ansIndices[0], reason: `Fallback index [${ansIndices[0]}]` };
  }

  return { index: 0, reason: 'Default index 0 fallback' };
}

function resolveMultipleChoiceOptions(options, ans) {
  if (!options || options.length === 0) return [];
  const ansTexts = (ans.answerTexts || []).map((t) => (t || '').trim()).filter(Boolean);
  const ansIndices = ans.answerIndices || [];

  const selected = [];

  options.forEach((opt, optIdx) => {
    const optClean = cleanFormulaText(opt.text);
    const optStripped = stripAll(opt.text);
    let matched = false;
    let matchReason = '';

    // Check 1: Exact / Clean formula match
    for (const ansText of ansTexts) {
      if (cleanFormulaText(ansText) === optClean) {
        matched = true;
        matchReason = `Exact match "${ansText}"`;
        break;
      }
    }

    // Check 2: Numeric equality match
    if (!matched && isNumericString(opt.text)) {
      const numOpt = Number(opt.text);
      for (const ansText of ansTexts) {
        if (isNumericString(ansText) && Math.abs(Number(ansText) - numOpt) < 1e-5) {
          matched = true;
          matchReason = `Numeric equality ${numOpt}`;
          break;
        }
      }
    }

    // Check 3: Punctuation & Space Insensitive Match
    if (!matched && optStripped.length >= 2) {
      for (const ansText of ansTexts) {
        if (stripAll(ansText) === optStripped) {
          matched = true;
          matchReason = `Normalized match "${ansText}"`;
          break;
        }
      }
    }

    // Check 4: Verified index match
    if (!matched && ansIndices.includes(optIdx)) {
      if (ansTexts.length === 0 || ansTexts.some((t) => stripAll(t).includes(optStripped) || optStripped.includes(stripAll(t)))) {
        matched = true;
        matchReason = `Verified index [${optIdx}]`;
      }
    }

    // Check 5: Phrase match for descriptive text
    if (!matched && !isNumericString(optClean) && optClean.length >= 4) {
      for (const ansText of ansTexts) {
        const cleanAns = cleanFormulaText(ansText);
        if (!isNumericString(cleanAns) && cleanAns.length >= 4 && (optClean.includes(cleanAns) || cleanAns.includes(optClean))) {
          matched = true;
          matchReason = `Phrase match with "${ansText}"`;
          break;
        }
      }
    }

    if (matched) {
      selected.push({ index: optIdx, text: opt.text, reason: matchReason });
    }
  });

  // Robust Fallbacks for Multiple Choice
  if (selected.length === 0) {
    for (const idx of ansIndices) {
      if (options[idx]) {
        selected.push({ index: idx, text: options[idx].text, reason: `Index fallback [${idx}]` });
      }
    }
  }
  if (selected.length === 0 && options.length > 0) {
    selected.push({ index: 0, text: options[0].text, reason: 'Default first option fallback' });
  }

  return selected;
}

function resolveAnswerIndices(question, aiAnswer) {
  if (question.type === 'checkbox') {
    return resolveMultipleChoiceOptions(question.options, aiAnswer).map((r) => r.index);
  }
  const single = resolveSingleChoiceOption(question.options, aiAnswer);
  return single.index >= 0 ? [single.index] : [0];
}

async function askAIForQuestion(q) {
  let prompt = `You are a distinguished university professor and academic quiz solver with 100% precision.\n`;
  prompt += `Solve the following LinkedIn Learning quiz question with absolute accuracy.\n\n`;
  prompt += `QUESTION:\n`;
  prompt += `Type: ${q.type === 'checkbox' ? 'multiple_choice (select all that apply)' : 'single_choice (select exactly one)'}\n`;
  prompt += `Prompt: ${q.prompt}\n`;
  prompt += `Options:\n`;
  q.options.forEach((opt, oIdx) => {
    prompt += `[Index ${oIdx}]: ${opt.text}\n`;
  });
  prompt += `\n`;
  prompt += `CRITICAL INSTRUCTIONS:
1. In 'rationale', write concise step-by-step reasoning proving why the chosen option is correct.
2. In 'answerTexts', provide the EXACT verbatim string(s) from the provided Options list matching your answer.
3. In 'answerIndices', provide the matching 0-based index(es) from the provided Options list.
4. For single_choice (radio): select EXACTLY ONE answer.
5. For multiple_choice (checkbox): select ALL correct options.

Output ONLY a valid JSON object without Markdown formatting:
{
  "rationale": "reasoning",
  "answerIndices": [0],
  "answerTexts": ["exact option string"]
}`;

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'ASK_AI', prompt }, resolve);
  });

  if (!response || !response.success || !response.text) {
    log('AI request failed, fallback to index 0:', response?.error);
    showHUD(`⚠️ AI Key Notice: ${response?.error || 'Using smart fallback'}`, 'error');
    await addLog(`AI request failed: ${response?.error || 'Unknown error'}`, 'warn');
    return {
      answerIndices: [0],
      answerTexts: [],
      provider: 'Fallback (Index 0)',
      rawPrompt: prompt,
      rawResponse: response?.error || 'No response'
    };
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

  if (Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed || typeof parsed !== 'object') {
    parsed = { answerIndices: [0], answerTexts: [] };
  }
  parsed.provider = response.provider || 'AI';
  parsed.rawPrompt = prompt;
  parsed.rawResponse = response.text;
  return parsed;
}

async function solveLinkedInQuiz() {
  if (isSolvingQuiz) return false;
  isSolvingQuiz = true;

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

      // 1. Check for "Next question" or "Next" button (if previous answer was already evaluated and passed)
      const nextQuestionBtn = findButtonByText(/^next$|^next question$|^lanjutkan$|^berikutnya$/i);
      if (nextQuestionBtn && isElementClickable(nextQuestionBtn)) {
        log('Advancing to next question:', nextQuestionBtn.innerText);
        showHUD(`▶ Advancing to next question...`);
        clickElement(nextQuestionBtn);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }

      // 2. Check for "Start quiz", "Resume quiz", or "Take quiz" button
      const startBtn = findButtonByText(/start quiz|resume quiz|take quiz|begin quiz|mulai kuis|mulai tes/i);
      if (startBtn && isElementClickable(startBtn)) {
        log('Clicking Start/Resume Quiz button:', startBtn.innerText);
        showHUD(`▶ Clicking "${startBtn.innerText}"...`);
        clickElement(startBtn);
        await new Promise((r) => setTimeout(r, 1400));
        continue;
      }

      // 3. Check for "View results" or "See results" button
      const resultsBtn = findButtonByText(/view results|see results|lihat hasil/i);
      if (resultsBtn && isElementClickable(resultsBtn)) {
        log('Clicking View Results button:', resultsBtn.innerText);
        showHUD(`▶ Viewing quiz results...`);
        clickElement(resultsBtn);
        await new Promise((r) => setTimeout(r, 1400));
        continue;
      }

      // 4. Parse the current active question
      const currentQ = parseCurrentQuizQuestion();
      if (!currentQ || currentQ.options.length < 2) {
        // No active question on screen -> Check for final continue or "Return to course" button on results/summary screen
        const finalContinueBtn = findButtonByText(
          /return to course|back to course|kembali ke kursus|submit and continue|continue learning|continue to next|next lesson|finish quiz|done|^continue$/i
        );
        if (finalContinueBtn && isElementClickable(finalContinueBtn)) {
          log('Found final submit / continue / return button on results screen:', finalContinueBtn.innerText);
          showHUD(`✓ Quiz finished! Clicking "${finalContinueBtn.innerText}"...`, 'success');
          sendProgress({ message: `✓ Quiz finished! Clicking "${finalContinueBtn.innerText}"...` });
          await addLog(`✓ Quiz completed! Clicking "${finalContinueBtn.innerText}"`, 'success');
          clickElement(finalContinueBtn);
          await new Promise((r) => setTimeout(r, 2000));
          break;
        }

        // Check if quiz is already marked as completed in syllabus
        expandAllSections();
        const syllabus = getCourseSyllabus();
        const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
        const quizItem = syllabus.find((l) => {
          const h = (l.href || '').toLowerCase();
          return h.includes(currentPath) || currentPath.includes(h);
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

        log('No active question or navigation buttons detected. Finishing loop.');
        break;
      }

      // Anti-loop safeguard: check if stuck on the exact same prompt
      if (currentQ.prompt === lastHandledPrompt) {
        consecutiveSamePromptCount++;
        if (consecutiveSamePromptCount >= 3) {
          log('Stuck on same prompt 3 times. Attempting submit/advance:', currentQ.prompt);
          const anySubmit = findButtonByText(/^submit$|^continue$|^next$|^kirim$|^lanjutkan$/i, true);
          if (anySubmit) {
            clickElement(anySubmit);
            await new Promise((r) => setTimeout(r, 1500));
          }
          break;
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
          await selectOption(opt, shouldSelect);
          if (shouldSelect) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        showHUD(`✓ Marked: [${markedTexts.join(', ')}]`);
        log(`Selected checkbox options [${chosenIndices.join(', ')}]: "${markedTexts.join(', ')}"`);
      } else {
        const resolution = resolveSingleChoiceOption(currentQ.options, aiAnswer);
        const chosenIdx = resolution.index >= 0 ? resolution.index : 0;
        chosenIndices = [chosenIdx];
        const chosenOpt = currentQ.options[chosenIdx];
        if (chosenOpt) {
          await selectOption(chosenOpt, true);
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

      // 7. Find and click question Submit or Advance button
      let advanceBtn = null;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 3000) {
        advanceBtn = findQuizActionAdvanceButton();
        if (advanceBtn && isElementClickable(advanceBtn)) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      if (advanceBtn) {
        const btnText = (advanceBtn.innerText || advanceBtn.value || advanceBtn.getAttribute('aria-label') || 'Submit').trim();
        log('Clicking Quiz Advance/Submit button:', btnText);
        showHUD(`▶ Submitting: "${btnText}"...`);
        try {
          advanceBtn.removeAttribute('disabled');
          advanceBtn.disabled = false;
          advanceBtn.setAttribute('aria-disabled', 'false');
        } catch (e) {}
        clickElement(advanceBtn);
      } else {
        log('Advance/Submit button not found. Checking for fallback...');
        const fallbackBtn = findButtonByText(/^next$|^submit$|^skip$|^continue$|^lanjutkan$|^berikutnya$/i, true);
        if (fallbackBtn && !isForbiddenQuizButton(fallbackBtn)) {
          clickElement(fallbackBtn);
        }
      }

      // Wait 1.4s for LinkedIn to evaluate and transition
      await new Promise((r) => setTimeout(r, 1400));

      // 8. If follow-up "Next question", "Next", or "Submit and continue" appeared after submission
      const followUpBtn = findButtonByText(
        /submit and continue|next question|^next$|lanjutkan|berikutnya|view results|see results|continue/i
      );
      if (followUpBtn && isElementClickable(followUpBtn) && !isForbiddenQuizButton(followUpBtn)) {
        log('Clicking follow-up advance button:', followUpBtn.innerText);
        showHUD(`▶ Advancing: "${followUpBtn.innerText}"...`);
        clickElement(followUpBtn);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    log('Chapter Quiz solving loop ended.');
    await new Promise((r) => setTimeout(r, 1200));
    isSolvingQuiz = false;
    return true;
  } catch (err) {
    log('Quiz solver error:', err);
    showHUD('❌ Quiz solver error: ' + err.message, 'error');
    isSolvingQuiz = false;
    return false;
  }
}

// ─── 🛡️ Green Tick Verification & Auto-Retry Engine ─────────────────────────

async function verifyQuizGreenTick(maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    expandAllSections();

    // Check 1: Active item in syllabus sidebar
    const activeSidebarItem = document.querySelector(
      'li.classroom-toc-item--selected, li.selected, li.active, [aria-current="page"], [aria-selected="true"]'
    );
    if (activeSidebarItem) {
      const row = activeSidebarItem.closest('li') || activeSidebarItem;
      if (isLessonCompleted(row)) {
        log('✓ Green tick confirmed on active sidebar item!');
        return true;
      }
    }

    // Check 2: Match by syllabus item URL
    const syllabus = getCourseSyllabus();
    const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
    const quizItem = syllabus.find((l) => {
      const h = (l.href || '').toLowerCase();
      return h.includes(currentPath) || currentPath.includes(h);
    });

    if (quizItem && quizItem.completed) {
      log('✓ Green tick confirmed on syllabus for:', quizItem.title);
      return true;
    }

    // Check 3: Check any quiz item in syllabus if current page is a quiz
    for (const item of syllabus) {
      if (/quiz|assessment/i.test(item.title) && item.completed) {
        log('✓ Green tick confirmed on quiz item:', item.title);
        return true;
      }
    }

    // Check 4: Check if page itself indicates passed or completed
    const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
    if (
      /you passed|quiz passed|congratulations.*passed|score: 100%|score: [7-9]\d%|assessment complete|skill assessment.*complete|results/i.test(bodyText) ||
      (window.location.pathname.includes('career-hub') && (document.body ? document.body.innerText : '').includes('Return to course'))
    ) {
      log('✓ Quiz / Assessment completion confirmed!');
      return true;
    }

    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

async function solveLinkedInQuizWithGreenTickRetry(maxRetries = 5) {
  if (isSolvingQuiz) return false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`Starting Quiz Attempt ${attempt}/${maxRetries}...`);
    showHUD(`🧠 Auto-Solving Quiz: Attempt ${attempt}/${maxRetries}...`);

    await solveLinkedInQuiz();

    // Check for any lingering "Return to course", "Submit and continue", or "Continue" button
    const lingeringSubmit = findButtonByText(/return to course|back to course|kembali ke kursus|submit and continue|continue learning|continue to next|^continue$/i);
    if (lingeringSubmit && isElementClickable(lingeringSubmit)) {
      log('Clicking final submit / return button:', lingeringSubmit.innerText);
      showHUD(`✓ Finalizing quiz: "${lingeringSubmit.innerText}"...`, 'success');
      clickElement(lingeringSubmit);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Pause 2.5s for LinkedIn's backend to process answers and update syllabus checkmark
    showHUD('⏳ Verifying green tick in syllabus...');
    await new Promise((r) => setTimeout(r, 2500));

    const isVerified = await verifyQuizGreenTick(5000);
    if (isVerified) {
      log('🎉 Green tick / Completion CONFIRMED on quiz!');
      showHUD('✅ Verified! Quiz completed.', 'success');
      sendProgress({ message: '🎉 Chapter Quiz verified!' });
      return true;
    }

    // No green tick verified -> Retry
    log(`⚠️ Attempt ${attempt}: No green tick detected on syllabus. Retrying quiz...`);
    showHUD(`⚠️ No green tick found. Retrying quiz (attempt ${attempt + 1})...`, 'warn');

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1200));

      // 1. Look for Retake / Try again button
      const retakeBtn = findButtonByText(/^retake$|retake quiz|take quiz again|try again|restart quiz|take again/i);
      if (retakeBtn && isElementClickable(retakeBtn)) {
        log('Clicking Retake Quiz button:', retakeBtn.innerText);
        showHUD(`▶ Clicking "${retakeBtn.innerText}"...`);
        clickElement(retakeBtn);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        // Check for Return to course on Career Hub assessments before reloading
        const returnBtn = findButtonByText(/return to course|back to course|kembali ke kursus/i);
        if (returnBtn && isElementClickable(returnBtn)) {
          log('Career Hub assessment completed, returning to course:', returnBtn.innerText);
          clickElement(returnBtn);
          await new Promise((r) => setTimeout(r, 2500));
          return true;
        }

        // 2. Check for any remaining Submit and continue or View results button
        const finalBtn = findButtonByText(/submit and continue|continue|view results/i);
        if (finalBtn && isElementClickable(finalBtn)) {
          clickElement(finalBtn);
          await new Promise((r) => setTimeout(r, 2000));
          const recheck = await verifyQuizGreenTick(3000);
          if (recheck) return true;
        }

        // 3. Fallback: reload page to reset question state
        log('No retake button found. Reloading quiz page to retry...');
        showHUD('▶ Reloading quiz page to retry attempt...');
        await new Promise((r) => setTimeout(r, 1500));
        window.location.reload();
        return false;
      }
    }
  }

  log('Reached maximum quiz retry attempts.');
  showHUD('❌ Quiz not verified by green tick after retries.', 'error');
  return false;
}

const solvedQuizUrls = new Set();
let quizAutoTriggerTimer = null;
let lastQuizCheckTime = 0;

function checkAndAutoSolveQuiz() {
  if (isBulkActive || isSolvingQuiz || !autoSolveQuizzes) return;

  const currentCleanUrl = window.location.href.split('?')[0].split('#')[0];
  if (solvedQuizUrls.has(currentCleanUrl)) {
    return;
  }

  const now = Date.now();
  if (now - lastQuizCheckTime < 2000) return;
  lastQuizCheckTime = now;

  if (isQuizOnPage()) {
    expandAllSections();
    const syllabus = getCourseSyllabus();
    const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
    const quizItem = syllabus.find((l) => {
      const h = (l.href || '').toLowerCase();
      return h.includes(currentPath) || currentPath.includes(h);
    });

    if (quizItem && quizItem.completed) {
      solvedQuizUrls.add(currentCleanUrl);
      return;
    }

    const activeSidebarItem = document.querySelector(
      'li.classroom-toc-item--selected, li.selected, li.active, [aria-current="page"]'
    );
    if (activeSidebarItem && isLessonCompleted(activeSidebarItem)) {
      solvedQuizUrls.add(currentCleanUrl);
      return;
    }

    if (quizAutoTriggerTimer) clearTimeout(quizAutoTriggerTimer);
    quizAutoTriggerTimer = setTimeout(() => {
      if (!isSolvingQuiz && isQuizOnPage() && autoSolveQuizzes) {
        log('Uncompleted quiz detected! Auto-solving with Green Tick verification...');
        solveLinkedInQuizWithGreenTickRetry().then((ok) => {
          if (ok) solvedQuizUrls.add(currentCleanUrl);
        });
      }
    }, 1500);
  }
}

// ─── Autonomous Bulk Video Completer (Videos Only Mode) ──────────────────────

let isRunningAutonomousStep = false;
let isNavigatingToLesson = false;
let lastStepRunTime = 0;

async function runAutonomousStep() {
  if (!isBulkActive) return;
  if (isRunningAutonomousStep || isNavigatingToLesson) {
    return;
  }

  const now = Date.now();
  if (now - lastStepRunTime < 800) return;
  lastStepRunTime = now;

  isRunningAutonomousStep = true;

  try {
    startAudioKeepalive();

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

    // 0. CHECK FIRST: If page is a quiz or Career Hub assessment, solve it immediately!
    if (isQuizOnPage()) {
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
        const solved = await solveLinkedInQuizWithGreenTickRetry();
        if (solved) {
          const returnBtn = findButtonByText(/return to course|back to course|kembali ke kursus|continue learning/i);
          if (returnBtn && isElementClickable(returnBtn)) {
            log('Returning to course from assessment:', returnBtn.innerText);
            clickElement(returnBtn);
            await new Promise((r) => setTimeout(r, 2500));
          }
        }
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
      const pathReturned = await returnToLearningPath();
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

    // 2. Identify current lesson
    const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
    const currentLessonIndex = syllabus.findIndex((l) => {
      const h = (l.href || '').toLowerCase();
      return h.includes(currentPath) || currentPath.includes(h);
    });
    const currentLesson = currentLessonIndex !== -1 ? syllabus[currentLessonIndex] : null;

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
    const video = document.querySelector('video');
    const hasVideo = !!video;
    const isCurrentVideo = hasVideo || (currentLesson && currentLesson.isVideo && !currentLesson.isQuiz);

    const isCurrentQuiz = !isCurrentVideo && (
      isQuizOnPage() ||
      currentPath.includes('/quiz/') ||
      currentPath.includes('/assessment/') ||
      currentPath.includes('/exam/') ||
      (currentLesson && currentLesson.isQuiz)
    );

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
        const solved = await solveLinkedInQuizWithGreenTickRetry();
        if (solved) {
          log('Quiz passed & verified with green tick! Advancing to next uncompleted task...');
          expandAllSections();
          const updatedSyllabus = getCourseSyllabus();
          await advanceToNextItem(updatedSyllabus, currentLessonIndex, activeFocusMode);
        }
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

      if (video.ended || (video.duration > 0 && video.currentTime >= video.duration - 0.5)) {
        log('Video is already ended. Advancing to next item...');
        await handleVideoEnded(currentPath, currentLessonIndex, activeFocusMode);
        return;
      }

      showHUD(`▶ Playing video at ${speedToApply}x (${Math.round(video.currentTime)}s / ${Math.round(video.duration || 0)}s)...`);

      if (video.paused) {
        video.play().catch(() => {
          const playBtn = document.querySelector(
            'button.classroom-video-player__play-pause-button, button[data-control-name="play"], button[aria-label*="Play" i], button[aria-label*="Putar" i], .vjs-play-control, button.play-button'
          );
          if (playBtn && isElementClickable(playBtn)) {
            clickElement(playBtn);
          }
        });
      }

      const onEnded = async () => {
        video.removeEventListener('ended', onEnded);
        await handleVideoEnded(currentPath, currentLessonIndex, activeFocusMode);
      };

      video.addEventListener('ended', onEnded, { once: true });
      return;
    }

    // 8. Video player is mounting or loading:
    log('Waiting for video player to mount...');
    setTimeout(() => {
      if (!isBulkActive) return;
      const v = document.querySelector('video');
      if (v) {
        runAutonomousStep();
      } else {
        expandAllSections();
        const updated = getCourseSyllabus();
        advanceToNextItem(updated, currentLessonIndex, activeFocusMode);
      }
    }, 1500);
  } finally {
    isRunningAutonomousStep = false;
  }
}

async function handleVideoEnded(currentPath, currentLessonIndex, mode = 'pending_only') {
  log('Video ended. Waiting for LinkedIn to award green checkmark...');
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 500));
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
  await advanceToNextItem(updatedSyllabus, currentLessonIndex, mode);
}

async function advanceToNextItem(syllabus, currentIdx = -1, mode = 'pending_only') {
  if (!syllabus || syllabus.length === 0) return;
  const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();

  const isEligible = (l) => {
    if (l.completed) return false;
    if (mode === 'videos_only') return l.isVideo;
    if (mode === 'quizzes_only') return l.isQuiz;
    return true; // 'all' or 'pending_only'
  };

  // 1. Search FORWARD from current index
  let nextItem = null;
  if (currentIdx !== -1) {
    for (let i = currentIdx + 1; i < syllabus.length; i++) {
      if (isEligible(syllabus[i])) {
        nextItem = syllabus[i];
        break;
      }
    }
  }

  // 2. Wrap around from start
  if (!nextItem) {
    nextItem = syllabus.find((l) => {
      if (!isEligible(l)) return false;
      const h = (l.href || '').toLowerCase();
      return !h.includes(currentPath) && !currentPath.includes(h);
    });
  }

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
    const pathReturned = await returnToLearningPath();
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

function navigateToLesson(lesson) {
  if (!lesson) return;
  const targetUrl = lesson.fullHref || lesson.href;
  if (!targetUrl) return;
  log('Navigating to lesson:', lesson.title, '->', targetUrl);
  isNavigatingToLesson = true;

  if (navWatchdogTimer) clearTimeout(navWatchdogTimer);
  navWatchdogTimer = setTimeout(() => {
    isNavigatingToLesson = false;
    const currentClean = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
    const targetClean = lesson.href.split('?')[0].split('#')[0].toLowerCase();
    if (isBulkActive && !currentClean.includes(targetClean) && !targetClean.includes(currentClean)) {
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
}

// ─── Playback Engine & Anti-Freeze ────────────────────────────────────────────

function configureVideoForSpeed(video, speed) {
  if (!video) return;

  try {
    video.preservesPitch = false;
    video.webkitPreservesPitch = false;
    video.mozPreservesPitch = false;
  } catch (e) {}

  if (speed > 2) {
    if (!video.muted) {
      previousMuteState = false;
      video.muted = true;
    }
  } else {
    if (previousMuteState === false && video.muted) {
      video.muted = false;
    }
  }
}

function applySpeed(video, speed) {
  if (!video) return;

  configureVideoForSpeed(video, speed);
  lastRateChangeTime = Date.now();

  // Forward to MAIN world Native Speed Engine in page-inject.js
  try {
    window.postMessage({
      type: 'LI_FORCE_SPEED',
      speed: speed,
      enabled: true
    }, '*');
  } catch (e) {}

  try {
    video.playbackRate = speed;
  } catch (err) {}

  if (video.paused && !video.ended) {
    video.play().catch(() => {});
  }

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
      btn.click();
      return true;
    }
  }

  try {
    const currentPath = window.location.pathname;
    const tocLinks = Array.from(document.querySelectorAll('a[href*="/learning/"]'))
      .filter((a) => a.href && a.href.includes('/learning/'));

    const currentIndex = tocLinks.findIndex((a) => {
      const href = a.getAttribute('href') || '';
      return href.includes(currentPath) || a.classList.contains('active') || a.getAttribute('aria-current') === 'page';
    });

    if (currentIndex !== -1 && currentIndex + 1 < tocLinks.length) {
      tocLinks[currentIndex + 1].click();
      return true;
    }
  } catch (e) {}

  return false;
}

// ─── Watchdog Supervisor ──────────────────────────────────────────────────────

function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);

  watchdogInterval = setInterval(() => {
    // Always try to dismiss surveys when bulk mode is active
    if (isBulkActive) {
      dismissSurveyIfPresent();
    }

    if (isBulkActive) {
      if (isRunningAutonomousStep || isNavigatingToLesson || isSolvingQuiz) {
        return;
      }
      if (!videoEl || videoEl.ended || videoEl.paused) {
        runAutonomousStep();
      }
      return;
    }

    if (!videoEl) {
      const found = document.querySelector('video');
      if (found) {
        attachToVideo(found);
      } else {
        if (skipNonVideos && autoplayEnabled) {
          if (!nonVideoTimer) {
            nonVideoTimer = setTimeout(() => {
              nonVideoTimer = null;
              if (!document.querySelector('video')) {
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
    if (Date.now() - lastRateChangeTime > 500) {
      if (videoEl.playbackRate !== activeTargetRate) {
        applySpeed(videoEl, activeTargetRate);
      }
    }

    configureVideoForSpeed(videoEl, activeTargetRate);

    const now = videoEl.currentTime;
    if (now === lastRecordedTime && !videoEl.paused) {
      stuckCount++;
      if (stuckCount >= 3) {
        stuckCount = 0;
        try {
          videoEl.currentTime = Math.min(videoEl.duration - 0.1, videoEl.currentTime + 0.3);
          videoEl.play().catch(() => {});
        } catch (e) {}
      }
    } else {
      stuckCount = 0;
      lastRecordedTime = now;
    }

    if (videoEl.paused && !videoEl.ended && (autoplayEnabled || isBulkActive)) {
      if (videoEl.readyState >= 2) {
        videoEl.play().catch(() => {});
      }
    }
  }, 500);
}

// ─── Video Attachment ─────────────────────────────────────────────────────────

let _listenerController = null;

function attachToVideo(video) {
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
    if (Date.now() - lastRateChangeTime < 300) return;
    const rate = isBulkActive ? (currentSpeed || 16) : currentSpeed;
    if (video.playbackRate !== rate) {
      applySpeed(video, rate);
    }
  }, { signal });

  video.addEventListener('ended', () => {
    if (isBulkActive) {
      runAutonomousStep();
      return;
    }
    if (!autoplayEnabled) return;
    setTimeout(goToNextLesson, 800);
  }, { signal });

  video.addEventListener('canplay', () => {
    if (video.paused && !video.ended && (autoplayEnabled || isBulkActive)) {
      video.play().catch(() => {});
    }
  }, { signal });

  startWatchdog();
}

// ─── DOM Observer ─────────────────────────────────────────────────────────────

function startObserver() {
  const tryFind = () => {
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

  const stored = await chrome.storage.local.get([
    'bulkActive',
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
    if (typeof stored.playbackSpeed === 'number') currentSpeed = stored.playbackSpeed;
    else if (typeof stored.speed === 'number') currentSpeed = stored.speed;
    if (stored.focusMode) focusMode = stored.focusMode;
    if (stored.strictCompletion !== undefined) strictCompletionEnabled = !!stored.strictCompletion;
    if (typeof stored.autoplay === 'boolean') autoplayEnabled = stored.autoplay;
    if (typeof stored.skipNonVideos === 'boolean') skipNonVideos = stored.skipNonVideos;
    if (typeof stored.autoSolveQuizzes === 'boolean') autoSolveQuizzes = stored.autoSolveQuizzes;
    else if (typeof stored.autoSolve === 'boolean') autoSolveQuizzes = stored.autoSolve;

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

    if (stored.bulkActive === true) {
      log('Resuming autonomous bulk course completion...');
      if (learningPathActive) {
        log('Learning Path mode active. Path URL:', lastLearningPathUrl);
      }
      isBulkActive = true;
      setTimeout(runAutonomousStep, 1000);
    }
  }
}

init();

// ─── Messaging (Popup ↔ Content) ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startBulkComplete') {
    if (message.focusMode) focusMode = message.focusMode;
    if (message.speed) currentSpeed = parseFloat(message.speed) || currentSpeed;
    isBulkActive = true;
    chrome.storage.local.set({ bulkActive: true, focusMode, playbackSpeed: currentSpeed });
    addLog(`🚀 AutoPilot started (Focus Mode: ${focusMode}, Speed: ${currentSpeed}x)`, 'info');
    runAutonomousStep();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'stopBulkComplete') {
    isBulkActive = false;
    learningPathActive = false;
    lastLearningPathUrl = null;
    chrome.storage.local.set({ bulkActive: false, learningPathActive: false, lastLearningPathUrl: null });
    applySpeed(videoEl, 1);
    chrome.runtime.sendMessage({ action: 'updateBadge', text: '' });
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

  if (message.action === 'setSpeedInjection') {
    chrome.storage.local.set({ speedInjection: !!message.enabled });
    try {
      window.postMessage({
        type: 'LI_FORCE_SPEED',
        speed: message.enabled ? currentSpeed : 1.0,
        enabled: !!message.enabled
      }, '*');
    } catch (e) {}
    if (!message.enabled) {
      applySpeed(videoEl, 1);
    } else {
      applySpeed(videoEl, currentSpeed);
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'solveQuizNow') {
    solveLinkedInQuizWithGreenTickRetry().then((res) => {
      sendResponse({ success: res });
    });
    return true;
  }

  if (message.action === 'setSpeed') {
    const speed = parseFloat(message.speed);
    if (!isFinite(speed) || speed <= 0) {
      sendResponse({ success: false, error: 'Invalid speed.' });
      return true;
    }
    currentSpeed = speed;
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
    chrome.runtime.sendMessage({ action: 'setStorage', data: { autoSolveQuizzes } });
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
