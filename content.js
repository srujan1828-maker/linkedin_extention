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

  // 1. Text checks (Multilingual: EN, ID, ES, FR, DE)
  const text = ((container.innerText || '') + ' ' + (fullRow.innerText || '')).toLowerCase();
  const completionRegex = /\b(?:completed|watched|passed|quiz passed|selesai|lulus|ditonton|completado|visto|aprobado|terminé|réussi|abgeschlossen|bestanden)\b/i;
  const negativeRegex = /\b(?:not completed|unwatched|not started|belum selesai|belum dimulai|no completado|non terminé)\b/i;

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

  const sidebar = document.querySelector('#course-contents, [class*="classroom-toc"], ul.classroom-toc');
  let links = [];
  if (sidebar) {
    links = Array.from(sidebar.querySelectorAll('a')).filter((a) => {
      const h = a.getAttribute('href') || a.href || '';
      return h && !h.startsWith('#') && !h.includes('/search') && !a.closest('header, nav[aria-label="Primary" i]');
    });
  }
  if (links.length === 0) {
    links = Array.from(document.querySelectorAll(
      `a[href*="/learning/${courseSlug}/"], a[href*="/learning-career-hub/${courseSlug}/"], a[href*="/career-hub/${courseSlug}/"]`
    ));
  }
  const seen = new Set();
  const lessons = [];

  for (const a of links) {
    const rawHref = a.getAttribute('href') || a.href;
    const cleanHref = rawHref.split('?')[0].split('#')[0];

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
      const completed = isLessonCompleted(rowContainer);

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
  if (document.querySelector('#course-contents, [class*="classroom-toc"], ul.classroom-toc')) return false;

  // On paths pages, pause any preview/hero videos immediately
  pauseLearningPathVideos();

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
  if (document.querySelector('#course-contents, [class*="classroom-toc"], ul.classroom-toc')) return false;

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
function isPathItemCompleted(container) {
  if (!container) return false;

  const cardText = (container.innerText || '').toLowerCase();
  const cardAria = Array.from(container.querySelectorAll('[aria-label]'))
    .map((el) => (el.getAttribute('aria-label') || '').toLowerCase())
    .join(' ');
  const combined = cardText + ' ' + cardAria;

  // Negative checks: if it says "left", "remaining", or "incomplete", it's NOT completed
  if (/\b(?:\d+m?\s*\d*s?\s*left|\d+\s*left|remaining|incomplete|belum selesai|sisa)\b/i.test(combined)) {
    return false;
  }

  // 1. Explicit "Completed" text (e.g. "Completed 6/4/2026", "Completed", "Selesai")
  const completionRegex = /\b(?:completed\b(?:\s+\d+[\/\-]\d+[\/\-]\d+)?|selesai\b|completado\b|terminé\b|abgeschlossen\b)/i;
  const negativeRegex = /\b(?:not completed|belum selesai|no completado|non terminé)\b/i;

  if (completionRegex.test(combined) && !negativeRegex.test(combined)) {
    return true;
  }

  // If it has duration / progress text (e.g. "41m 55s", "54m 4s left", "1h 3m") and NO "completed" text, it is NOT completed
  if (!completionRegex.test(combined) && /\b\d+\s*(?:m|min|mnt|h|hr|j|s|sec|dtk)\b/i.test(cardText)) {
    return false;
  }

  // 2. SVG checkmark icon / badge explicitly inside a completion badge or status tag
  const checkBadges = container.querySelectorAll(
    '[class*="completed"], [class*="status--completed"], [class*="badge--completed"], li-icon[type*="check"], [data-test-icon*="check"]'
  );
  for (const b of checkBadges) {
    const bText = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
    if (!/bookmark/i.test(bText)) return true;
  }

  // 3. SVG with checkmark that is NOT a bookmark or bullet
  const svgs = container.querySelectorAll('svg');
  for (const svg of svgs) {
    const iconName = (
      svg.getAttribute('data-test-icon') ||
      svg.getAttribute('name') ||
      svg.getAttribute('aria-label') ||
      svg.getAttribute('type') ||
      ''
    ).toLowerCase();
    if (iconName.includes('bookmark') || iconName.includes('bullet') || iconName.includes('circle')) continue;
    if (iconName.includes('check') || iconName.includes('completed') || iconName.includes('success')) {
      return true;
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

  // 4. Delegate to general lesson completed checker
  if (isLessonCompleted(container)) {
    return true;
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
  const currentPathClean = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();

  // Strict list of site navigation / sidebar labels to IGNORE
  const siteNavFilter = /^(?:home|browse|certif.*|career paths?|my career plan|my content|ai coaching|ai role play|hands-on tech|featured.*|human skills|data analysis|help|save|share|add to.*|beranda|resume|start)$/i;

  // Specific blacklist for navigation routes (not courses)
  const navBlacklist = /\/(?:home|browse|certif[a-z]*|career-paths|my-career-plan|my-content|paths|learning-paths|search|me|saved|topics|instructors|providers|organizations|help|feedback)\b/i;

  // Find all candidate course links across the document
  const rawLinks = Array.from(document.querySelectorAll(
    'a[href*="/learning/"], a[href*="/learning-career-hub/"], a[href*="/career-hub/"]'
  ));

  const links = rawLinks.filter((a) => {
    // 1. Reject any link inside site navigation, left-rail sidebar, header, footer
    if (a.closest('nav, aside, header, footer, [role="navigation"], .global-nav, .side-nav, .nav-rail, .left-rail, [data-control-name*="nav"]')) {
      return false;
    }

    const rawHref = (a.getAttribute('href') || a.href || '').trim();
    const cleanHref = rawHref.split('?')[0].split('#')[0].toLowerCase();

    // 2. Must be on /learning/, /learning-career-hub/, or /career-hub/
    const isLearningUrl = cleanHref.includes('/learning/') || cleanHref.includes('/learning-career-hub/') || cleanHref.includes('/career-hub/');
    if (!isLearningUrl) return false;

    // 3. Reject site-wide navigation routes
    if (
      cleanHref.endsWith('/learning') ||
      cleanHref.endsWith('/learning/') ||
      cleanHref.endsWith('/learning-career-hub') ||
      cleanHref.endsWith('/learning-career-hub/') ||
      cleanHref.endsWith('/career-hub') ||
      cleanHref.endsWith('/career-hub/') ||
      navBlacklist.test(cleanHref)
    ) {
      return false;
    }

    // 4. Must not be the current path URL itself
    if (cleanHref === currentPathClean) return false;

    // 5. Check link text against navigation items
    const text = (a.innerText || '').trim();
    if (text.length > 0 && siteNavFilter.test(text)) return false;

    return true;
  });

  for (const a of links) {
    const rawHref = (a.getAttribute('href') || a.href || '').trim();
    const hrefClean = rawHref.split('?')[0].split('#')[0].toLowerCase();

    if (seen.has(hrefClean)) continue;

    // Find the course card container (search upwards from link)
    let card = a.closest('li, article, [class*="learning-path-item"], [class*="learning-path__item"], [class*="path-course"], [class*="entity-lockup"], [class*="card"]');
    if (!card) {
      let curr = a.parentElement;
      for (let depth = 0; depth < 4 && curr && curr !== document.body && curr.tagName !== 'SECTION' && curr.tagName !== 'MAIN'; depth++) {
        if (curr.querySelectorAll('a[href*="/learning"], a[href*="/career-hub"]').length <= 3) {
          card = curr;
        }
        curr = curr.parentElement;
      }
    }
    if (!card) card = a.parentElement || a;

    const cardText = (card.innerText || '').toLowerCase();
    // Exclude if card is solely a certificate or credential
    if (/certif|sertifikat|\bcerts?\b|credential|badge/i.test(cardText) && !/\b(?:course|video|kursus)\b/i.test(cardText)) {
      continue;
    }

    // Extract title: prefer link text, then card heading, then URL slug
    let title = (a.innerText || '').trim().replace(/\s+/g, ' ');
    title = title.replace(/^(?:course|kursus|cours|curso)\s+/i, '').trim();

    if (title.length < 3 || /^(?:view|watch|open|play|details?)$/i.test(title)) {
      const heading = card.querySelector('h3, h4, h2, [class*="title"], [class*="headline"], strong');
      if (heading) {
        const ht = (heading.innerText || '').trim().replace(/\s+/g, ' ');
        if (ht.length >= 3 && !siteNavFilter.test(ht) && !/^unit\s*\d+/i.test(ht) && !/content in this/i.test(ht)) {
          title = ht.replace(/^(?:course|kursus|cours|curso)\s+/i, '').trim();
        }
      }
    }

    if (title.length < 3 || siteNavFilter.test(title) || /^unit\s*\d+/i.test(title)) {
      const slug = hrefClean.split('/').filter(Boolean).pop() || '';
      title = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }

    if (title.length < 3) continue;

    seen.add(hrefClean);

    const type = /\bvideo\b/i.test(cardText) && !/\bcourse\b/i.test(cardText) ? 'video' : 'course';
    const completed = isPathItemCompleted(card);

    items.push({
      element: a,
      card,
      href: hrefClean,
      fullHref: a.href || rawHref,
      title,
      completed,
      type
    });
  }

  // Strategy 2: If no items found, inspect card elements directly in DOM
  if (items.length === 0) {
    const cards = Array.from(document.querySelectorAll(
      'li[class*="learning-path"], li[class*="item"], [data-test-learning-path-item], [data-test-path-item], [class*="path-course"], article, [class*="entity-lockup"]'
    )).filter((c) => {
      if (c.closest('nav, aside, header, footer, [role="navigation"], .global-nav, .side-nav, .nav-rail, .left-rail')) return false;
      const t = (c.innerText || '').trim();
      return t.length > 10 && /\b(?:course|video|kursus)\b/i.test(t);
    });

    for (const card of cards) {
      const a = card.querySelector('a[href*="/learning/"], a[href*="/learning-career-hub/"], a[href*="/career-hub/"]');
      if (!a) continue;
      const rawHref = (a.getAttribute('href') || a.href || '').trim();
      const hrefClean = rawHref.split('?')[0].split('#')[0].toLowerCase();
      if (!hrefClean || seen.has(hrefClean) || hrefClean === currentPathClean) continue;
      if (navBlacklist.test(hrefClean)) continue;

      let title = (a.innerText || '').trim().replace(/\s+/g, ' ');
      title = title.replace(/^(?:course|kursus|cours|curso)\s+/i, '').trim();
      if (title.length < 3 || siteNavFilter.test(title)) {
        const titleEl = card.querySelector('h2, h3, h4, [class*="title"], [class*="headline"]');
        if (titleEl) {
          title = (titleEl.innerText || '').trim().replace(/\s+/g, ' ');
          title = title.replace(/^(?:course|kursus|cours|curso)\s+/i, '').trim();
        }
      }
      if (title.length < 3 || siteNavFilter.test(title)) {
        const slug = hrefClean.split('/').filter(Boolean).pop() || '';
        title = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (title.length < 3) continue;

      seen.add(hrefClean);
      const completed = isPathItemCompleted(card);
      items.push({
        element: a,
        card,
        href: hrefClean,
        fullHref: a.href || rawHref,
        title,
        completed,
        type: /\bvideo\b/i.test(card.innerText) && !/\bcourse\b/i.test(card.innerText) ? 'video' : 'course'
      });
    }
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
    const href = (el.getAttribute('href') || el.href || '').toLowerCase();
    const combined = text + ' ' + aria;

    if (
      /back to learning path|back to path|kembali ke jalur pembelajaran|kembali ke path/i.test(combined) ||
      (href.includes('/learning/paths/') && (/back|kembali|←|↩/i.test(combined) || !text))
    ) {
      if (isElementClickable(el)) return el;
    }
  }

  // Check sidebar top area for path return link
  const sidebar = document.querySelector('#course-contents, [class*="classroom-toc"], aside, nav');
  if (sidebar) {
    const topLinks = sidebar.querySelectorAll('a[href*="/learning/paths/"], a');
    for (const link of topLinks) {
      const href = (link.getAttribute('href') || link.href || '').toLowerCase();
      const text = (link.innerText || '').trim().toLowerCase();
      if (href.includes('/learning/paths/') || (/back to|kembali ke|←|↩/i.test(text) && /path|jalur/i.test(text))) {
        if (isElementClickable(link)) return link;
      }
    }
  }

  // Check for ANY link to /learning/paths/ anywhere in header/nav/main
  const anyPathLink = document.querySelector('a[href*="/learning/paths/"], a[href*="/paths/"], a[href*="/learning-career-hub/paths/"]');
  if (anyPathLink && isElementClickable(anyPathLink)) {
    return anyPathLink;
  }

  return null;
}

/**
 * Handles one step of Learning Path auto-navigation.
 * Called when we detect we're on a Learning Path overview page.
 * Finds the first uncompleted course and clicks into it.
 */
async function handleLearningPathStep() {
  pauseLearningPathVideos();

  let items = getLearningPathItems();
  if (items.length === 0) {
    for (let retry = 0; retry < 6; retry++) {
      await new Promise((r) => setTimeout(r, 600));
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

  // 1. Try to click the "Back to Learning Path" button/link first
  const backBtn = findBackToLearningPathButton();
  if (backBtn && isElementClickable(backBtn)) {
    log('Clicking "Back to Learning Path" button/link:', backBtn.innerText || backBtn.href);
    showHUD('🎉 Course completed! Returning to Learning Path...', 'success');
    await addLog('🎉 Course completed! Returning to Learning Path...', 'success');

    const pathHref = backBtn.getAttribute('href') || backBtn.href || stored.lastLearningPathUrl;
    if (pathHref && pathHref.includes('/learning/paths/')) {
      await chrome.storage.local.set({
        learningPathActive: true,
        lastLearningPathUrl: pathHref
      });
    }

    clickElement(backBtn);
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  }

  // 2. Fall back to saved URL
  if (stored.lastLearningPathUrl) {
    log('Navigating to saved Learning Path URL:', stored.lastLearningPathUrl);
    showHUD('🎉 Course completed! Returning to Learning Path...', 'success');
    await addLog('🎉 Course completed! Returning to Learning Path...', 'success');
    window.location.href = stored.lastLearningPathUrl;
    return true;
  }

  // 3. Fall back: check if document has ANY link to /learning/paths/
  const anyPathLink = document.querySelector('a[href*="/learning/paths/"], a[href*="/paths/"]');
  if (anyPathLink && anyPathLink.href) {
    log('Found Learning Path link in DOM, navigating:', anyPathLink.href);
    showHUD('🎉 Returning to Learning Path...', 'success');
    await chrome.storage.local.set({
      learningPathActive: true,
      lastLearningPathUrl: anyPathLink.href
    });
    window.location.href = anyPathLink.href;
    return true;
  }

  // 4. Fall back: check contextUrn in URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const contextUrn = urlParams.get('contextUrn');
  if (contextUrn && contextUrn.includes('LearningPath')) {
    log('Found contextUrn with LearningPath. Navigating back in history...');
    showHUD('🎉 Course completed! Navigating back to path...', 'success');
    window.history.back();
    return true;
  }

  // 5. Fall back: Navigate to default Chandigarh University Learning Path
  const defaultPathUrl = 'https://www.linkedin.com/learning/paths/chandigarh-university-introduction-to-problem-solving-14957838?u=92961692';
  log('Navigating to default Learning Path URL:', defaultPathUrl);
  showHUD('🎉 Returning to Chandigarh University Learning Path...', 'info');
  await chrome.storage.local.set({
    learningPathActive: true,
    lastLearningPathUrl: defaultPathUrl
  });
  window.location.href = defaultPathUrl;
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
  // Match ONLY the actual sidebar contents, TOC list, or aside element.
  // NEVER match layout wrappers with classes like classroom-layout--sidebar-open!
  return !!el.closest(
    '#course-contents, aside, .classroom-layout__sidebar, ul.classroom-toc, li.classroom-toc-item, nav[aria-label="Table of contents" i], .classroom-toc-section'
  );
}

function isQuizOnPage() {
  const mainArea = document.querySelector('main, .classroom-layout__main, .classroom-body, [role="main"]') || document.body;
  const hasCounterOnPage = !!mainArea.querySelector('.quiz-challenge__counter, [class*="question-counter"], .quiz-step-counter');
  const hasQuizCard = !!mainArea.querySelector('.quiz-challenge, [class*="quiz-challenge"], .classroom-quiz');
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

async function selectOption(option, shouldCheck = true) {
  if (!option) return false;

  const input = option.input || (option.target && option.target.tagName === 'INPUT' ? option.target : option.target?.querySelector('input'));
  let label = option.label || (input ? (input.closest('label') || (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null)) : null);
  const card = option.card || option.target || label;
  const target = label || card || input;

  if (!target || isLanguageElement(target) || isInsideSidebar(target)) {
    return false;
  }

  try {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus();
  } catch (e) {}

  // 1. Dispatch full pointer and click events on target / label
  try {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    target.click();
  } catch (e) {}

  // 2. Click the custom radio indicator circle if present (Artdeco)
  const indicator = target.querySelector('.artdeco-radio-indicator, [class*="indicator"], [class*="radio-circle"]') ||
                    card?.querySelector('.artdeco-radio-indicator, [class*="indicator"], [class*="radio-circle"]');
  if (indicator) {
    try {
      indicator.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
  }

  // 3. Click the underlying input element directly if present
  if (input) {
    try {
      input.focus();
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      input.checked = shouldCheck;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
  }

  // 4. Also click the card container if distinct from target
  if (card && card !== target) {
    try {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
  }

  // 5. Update ARIA state
  if (target.hasAttribute && target.hasAttribute('role')) {
    try {
      target.setAttribute('aria-checked', shouldCheck ? 'true' : 'false');
      target.setAttribute('aria-pressed', shouldCheck ? 'true' : 'false');
    } catch (e) {}
  }

  await new Promise((r) => setTimeout(r, 200));

  // 6. Force-enable the Submit button
  const advanceBtn = findQuizActionAdvanceButton();
  if (advanceBtn) {
    try {
      advanceBtn.removeAttribute('disabled');
      advanceBtn.disabled = false;
      advanceBtn.setAttribute('aria-disabled', 'false');
      advanceBtn.classList.remove('artdeco-button--disabled');
    } catch (e) {}
  }

}

async function selectOptionAndVerify(option) {
  return selectOption(option, true);
}

function resolveSingleChoiceOption(options, ans, knownWrongAnswers = []) {
  if (!options || options.length === 0) return { index: -1, reason: 'No options available' };
  const ansTexts = (ans.answerTexts || []).map((t) => (t || '').trim()).filter(Boolean);
  const ansIndices = ans.answerIndices || [];

  const isWrong = (txt) => {
    return (knownWrongAnswers || []).some((w) => cleanFormulaText(w) === cleanFormulaText(txt) || stripAll(w) === stripAll(txt));
  };

  // TIER 1: Exact / Clean Formula Match
  for (const ansText of ansTexts) {
    const cleanAns = cleanFormulaText(ansText);
    const matchIdx = options.findIndex((o) => cleanFormulaText(o.text) === cleanAns);
    if (matchIdx !== -1 && !isWrong(options[matchIdx].text)) {
      return { index: matchIdx, reason: `Exact formula match: "${ansText}"` };
    }
  }

  // TIER 2: Numeric Equality Match (prevents float/integer discrepancies)
  for (const ansText of ansTexts) {
    if (isNumericString(ansText)) {
      const numAns = Number(ansText);
      const matchIdx = options.findIndex((o) => isNumericString(o.text) && Math.abs(Number(o.text) - numAns) < 1e-5);
      if (matchIdx !== -1 && !isWrong(options[matchIdx].text)) {
        return { index: matchIdx, reason: `Numeric equality match: ${numAns}` };
      }
    }
  }

  // TIER 3: Punctuation & Space Insensitive Match
  for (const ansText of ansTexts) {
    const strippedAns = stripAll(ansText);
    if (strippedAns.length >= 2) {
      const matchIdx = options.findIndex((o) => stripAll(o.text) === strippedAns);
      if (matchIdx !== -1 && !isWrong(options[matchIdx].text)) {
        return { index: matchIdx, reason: `Normalized match: "${ansText}"` };
      }
    }
  }

  // TIER 4: Verified Index Match
  if (ansIndices.length > 0) {
    const idx = ansIndices[0];
    if (options[idx] && !isWrong(options[idx].text)) {
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
      if (matchIdx !== -1 && !isWrong(options[matchIdx].text)) {
        return { index: matchIdx, reason: `Substring match: "${ansText}" in "${options[matchIdx].text}"` };
      }
    }
  }

  // TIER 6: Fallback to index if within bounds and not wrong
  if (ansIndices.length > 0 && options[ansIndices[0]] && !isWrong(options[ansIndices[0]].text)) {
    return { index: ansIndices[0], reason: `Fallback index [${ansIndices[0]}]` };
  }

  // TIER 7: First un-eliminated option
  for (let i = 0; i < options.length; i++) {
    if (!isWrong(options[i].text)) {
      return { index: i, reason: `Uneliminated candidate [${i}]` };
    }
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
      const qKey = promptText.toLowerCase();

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
          quizCorrectAnswersMap.set(qKey, optText);
          learnedCount++;
          log(`Learned CORRECT answer for "${promptText}": "${optText}"`);
        } else if (isIncorrect) {
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
  const questionKey = (q.prompt || '').trim().toLowerCase();

  // 1. Check if we already have the verified correct answer from review feedback!
  const knownCorrectAnswer = quizCorrectAnswersMap.get(questionKey);
  if (knownCorrectAnswer) {
    log(`Using verified correct answer for "${q.prompt}": "${knownCorrectAnswer}"`);
    const matchIdx = q.options.findIndex((o) => cleanFormulaText(o.text) === cleanFormulaText(knownCorrectAnswer) || stripAll(o.text) === stripAll(knownCorrectAnswer));
    const targetIdx = matchIdx !== -1 ? matchIdx : 0;
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

  let prompt = `You are a distinguished university professor and academic expert solving a certification exam with 100% precision.\n`;
  prompt += `Solve the following LinkedIn Learning course quiz question with absolute accuracy.\n\n`;
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

  // Calculate smart fallback index avoiding known wrong answers:
  let fallbackIdx = 0;
  for (let i = 0; i < q.options.length; i++) {
    const optText = q.options[i].text;
    if (!knownWrongAnswers.some(w => cleanFormulaText(w) === cleanFormulaText(optText) || stripAll(w) === stripAll(optText))) {
      fallbackIdx = i;
      break;
    }
  }

  if (!response || !response.success || !response.text) {
    log(`AI request failed, fallback to index ${fallbackIdx}:`, response?.error);
    showHUD(`⚠️ AI Key Notice: ${response?.error || 'Using smart fallback'}`, 'error');
    await addLog(`AI request failed: ${response?.error || 'Unknown error'}`, 'warn');
    return {
      answerIndices: [fallbackIdx],
      answerTexts: [q.options[fallbackIdx]?.text || ''],
      provider: `Fallback (Index ${fallbackIdx})`,
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

  // Regex fallback if JSON parsing failed
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.answerIndices)) {
    const idxMatch = text.match(/"answerIndices"\s*:\s*\[([0-9,\s]+)\]/i);
    if (idxMatch) {
      const extractedIndices = idxMatch[1].split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));
      if (extractedIndices.length > 0) {
        parsed = { answerIndices: extractedIndices, answerTexts: [] };
      }
    }
  }

  if (Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed || typeof parsed !== 'object') {
    parsed = { answerIndices: [fallbackIdx], answerTexts: [q.options[fallbackIdx]?.text || ''] };
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

      // 1. Check for "Start quiz", "Resume quiz", or "Take quiz" button
      const startBtn = findButtonByText(/start quiz|resume quiz|take quiz|begin quiz|mulai kuis|mulai tes/i);
      if (startBtn && isElementClickable(startBtn)) {
        log('Clicking Start/Resume Quiz button:', startBtn.innerText);
        showHUD(`▶ Clicking "${startBtn.innerText}"...`);
        clickElement(startBtn);
        await new Promise((r) => setTimeout(r, 1400));
        continue;
      }

      // 2. Check for "View results" or "See results" button
      const resultsBtn = findButtonByText(/view results|see results|lihat hasil/i);
      if (resultsBtn && isElementClickable(resultsBtn)) {
        log('Clicking View Results button:', resultsBtn.innerText);
        showHUD(`▶ Viewing quiz results...`);
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
        const isFailedScreen = /keep practicing|retake the quiz|take the quiz again|try again|review your answers|answered \d+ of \d+ questions correctly/i.test(bodyText);

        // If quiz was NOT passed, NEVER click continue! Trigger retake or review!
        if (isFailedScreen) {
          log('Quiz score screen: quiz not passed yet. Looking for Retake or Review...');
          const retakeBtn = findButtonByText(/^retake$|retake quiz|take quiz again|try again|restart quiz|take again/i);
          if (retakeBtn && isElementClickable(retakeBtn)) {
            log('Clicking Retake button on score screen:', retakeBtn.innerText);
            showHUD(`▶ Retrying quiz: "${retakeBtn.innerText}"...`);
            clickElement(retakeBtn);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          const reviewBtn = findButtonByText(/review all answers|review answers|tinjau jawaban/i);
          if (reviewBtn && isElementClickable(reviewBtn)) {
            log('Clicking Review all answers to learn correct options:', reviewBtn.innerText);
            clickElement(reviewBtn);
            await new Promise((r) => setTimeout(r, 2000));
            learnFromQuizReviewScreen();
            const retakeAfterReview = findButtonByText(/^retake$|retake quiz|take quiz again|try again/i);
            if (retakeAfterReview && isElementClickable(retakeAfterReview)) {
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
          clickElement(finalContinueBtn);
          await new Promise((r) => setTimeout(r, 2000));
          break;
        }

        // Check if there is an un-clicked results or next button
        const lingeringNext = findButtonByText(/^next question$|^view results$|^see results$/i);
        if (lingeringNext && isElementClickable(lingeringNext) && !isForbiddenQuizButton(lingeringNext)) {
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
        const qKey = (currentQ.prompt || '').trim().toLowerCase();
        const knownWrong = quizWrongAnswersMap.get(qKey) || [];
        const resolution = resolveSingleChoiceOption(currentQ.options, aiAnswer, knownWrong);
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

      // Record incorrect answers in memory so retries eliminate wrong options
      const isIncorrectFeedback = !!document.querySelector('.quiz-challenge__feedback--incorrect, [class*="feedback--incorrect"], [class*="status--incorrect"], [aria-label*="incorrect" i]');
      const feedbackText = (document.querySelector('.quiz-challenge__feedback, [class*="feedback"], .quiz-challenge__status')?.innerText || '').toLowerCase();
      if (isIncorrectFeedback || feedbackText.includes('incorrect') || feedbackText.includes('salah')) {
        const qKey = (currentQ.prompt || '').trim().toLowerCase();
        const wrongList = quizWrongAnswersMap.get(qKey) || [];
        for (const t of markedTexts) {
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

    // Pause 2s for LinkedIn backend to process answers and update checkmark
    showHUD('⏳ Verifying green tick in syllabus...');
    await new Promise((r) => setTimeout(r, 2000));

    const isVerified = await verifyQuizGreenTick(4000);
    if (isVerified) {
      log('🎉 Green tick / Completion CONFIRMED on quiz!');
      showHUD('✅ Verified! Quiz completed.', 'success');
      sendProgress({ message: '🎉 Chapter Quiz verified!' });

      // Click lingering "Return to course" or "Submit and continue" now that quiz is verified
      const lingeringSubmit = findButtonByText(/return to course|back to course|kembali ke kursus|submit and continue|next lesson/i);
      if (lingeringSubmit && isElementClickable(lingeringSubmit) && !isForbiddenQuizButton(lingeringSubmit)) {
        log('Clicking final return / continue button:', lingeringSubmit.innerText);
        clickElement(lingeringSubmit);
        await new Promise((r) => setTimeout(r, 2000));
      }
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
        clickElement(retakeBtn);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        // 2. Check for "Review all answers" button to see explanations and reveal Retake button
        const reviewBtn = findButtonByText(/review all answers|review answers|tinjau jawaban/i);
        if (reviewBtn && isElementClickable(reviewBtn)) {
          log('Clicking Review all answers to learn correct options:', reviewBtn.innerText);
          clickElement(reviewBtn);
          await new Promise((r) => setTimeout(r, 2000));
          learnFromQuizReviewScreen();
          const retakeAfter = findButtonByText(/^retake$|retake quiz|take quiz again|try again|restart quiz/i);
          if (retakeAfter && isElementClickable(retakeAfter)) {
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
            clickElement(tocQuiz);
            await new Promise((r) => setTimeout(r, 2500));
          }
        }
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
      if (alreadyPassed) {
        log('⏩ Quiz already passed with green tick! Skipping to next task...');
        showHUD('⏩ Quiz already completed! Skipping to next task...', 'success');

        const returnBtn = findButtonByText(/return to course|back to course|kembali ke kursus|submit and continue|continue learning|^continue$/i);
        if (returnBtn && isElementClickable(returnBtn)) {
          clickElement(returnBtn);
          await new Promise((r) => setTimeout(r, 1500));
        }

        expandAllSections();
        const syllabus = getCourseSyllabus();
        const currentPath = window.location.pathname.split('?')[0].split('#')[0].toLowerCase();
        const currentLessonIndex = syllabus.findIndex((l) => {
          const h = (l.href || '').toLowerCase();
          return h.includes(currentPath) || currentPath.includes(h);
        });
        const storedConfig = await chrome.storage.local.get(['focusMode']);
        const activeFocusMode = storedConfig.focusMode || focusMode || 'pending_only';
        await advanceToNextItem(syllabus, currentLessonIndex, activeFocusMode);
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
    const activeIsCompleted = (currentLesson && currentLesson.completed) ||
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

  // Block any accidental navigation to certificates
  if (/\b(?:certificates?|sertifikat)\b/i.test(targetUrl)) {
    log('Blocked navigation to certificates link! Returning to learning path instead...');
    returnToLearningPath();
    return;
  }

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
      const t = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
      if (!/\b(?:certificate|certificates|sertifikat)\b/i.test(t)) {
        btn.click();
        return true;
      }
    }
  }

  try {
    // STRICTLY search within the syllabus sidebar TOC! Never query whole document!
    const sidebar = document.querySelector('#course-contents, [class*="classroom-toc"], ul.classroom-toc');
    if (!sidebar) {
      returnToLearningPath();
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
      returnToLearningPath();
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
      if (isGlobalNavPage()) {
        log('Watchdog: Detected on off-track global nav page. Escaping to Learning Path...');
        runAutonomousStep();
        return;
      }
      if (isLearningPathPage()) {
        runAutonomousStep();
        return;
      }
      if (!videoEl || videoEl.ended || videoEl.paused) {
        runAutonomousStep();
      }
      return;
    }

    if (!videoEl) {
      if (isLearningPathPage()) return;
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

    if (window.location.href.includes('/paths/')) {
      learningPathActive = true;
      lastLearningPathUrl = window.location.href;
      chrome.storage.local.set({
        learningPathActive: true,
        lastLearningPathUrl: window.location.href
      });
    }

    if (stored.bulkActive === true) {
      log('Resuming autonomous bulk course completion...');
      if (learningPathActive) {
        log('Learning Path mode active. Path URL:', lastLearningPathUrl);
      }
      isBulkActive = true;
      if (isGlobalNavPage()) {
        log('Init: On off-track global nav page with bulkActive=true. Escaping immediately...');
        setTimeout(() => { returnToLearningPath(); }, 400);
        return;
      }
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
    if (window.location.href.includes('/paths/')) {
      learningPathActive = true;
      lastLearningPathUrl = window.location.href;
      chrome.storage.local.set({
        learningPathActive: true,
        lastLearningPathUrl: window.location.href
      });
    }
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
