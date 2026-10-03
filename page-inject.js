/**
 * page-inject.js — Runs directly in the MAIN page world at document_start.
 * 
 * 1. Native Descriptor 16x Speed Engine (with capture-phase ratechange event shield).
 * 2. Background Play & Page Visibility API spoofing.
 * 3. React Virtual DOM Event Bridge for quiz option selection.
 */
(function() {
  'use strict';

  if (window.__li_speed_engine_installed__) return;
  window.__li_speed_engine_installed__ = true;

  let forcedSpeed = 1.0;
  let speedEngineEnabled = false;
  let backgroundPlayEnabled = false;
  let automationPlaybackEnabled = true;
  const userPausedMedia = new WeakSet();
  let lastPauseInteraction = null;

  let nativeHiddenGetter = null;
  const nativeHasFocus = typeof document.hasFocus === 'function' ? document.hasFocus.bind(document) : null;
  let pageBlurred = false;
  const backgroundCandidates = new Map();

  function actuallyInBackground() {
    return !!(nativeHiddenGetter?.call(document) || pageBlurred || (nativeHasFocus && !nativeHasFocus()));
  }

  function rememberPlayingMedia() {
    if (!backgroundPlayEnabled) return;
    document.querySelectorAll('video').forEach(media => {
      if (!media.paused && !media.ended && !backgroundCandidates.has(media)) {
        backgroundCandidates.set(media, { attempts: 0, pending: false });
      }
    });
  }

  function isQuizOrPathRoute() {
    return /\/(?:quiz|assessment|exam|paths|learning-paths)(?:\/|$)/i.test(window.location?.pathname || '');
  }

  function recoverBackgroundPause(media) {
    const state = backgroundCandidates.get(media);
    if (!state || state.pending || state.attempts >= 2) return;
    state.pending = true;
    const playbackPath = window.location?.pathname;
    setTimeout(async () => {
      if (isQuizOrPathRoute() || window.location?.pathname !== playbackPath || !backgroundPlayEnabled || !automationPlaybackEnabled || userPausedMedia.has(media) || backgroundCandidates.get(media) !== state || !actuallyInBackground() ||
          media.isConnected === false || media.ended || !media.paused) { state.pending = false; return; }
      state.attempts++;
      try {
        await media.play();
      } catch (error) {
        backgroundCandidates.delete(media);
        window.postMessage({ type: 'LI_BACKGROUND_PLAY_BLOCKED', path: playbackPath }, window.location.origin);
      } finally {
        state.pending = false;
      }
    }, 150);
  }

  // Preserve native visibility unless the user explicitly enables background play.
  for (const [property, visibleValue] of [
    ['hidden', false], ['visibilityState', 'visible'],
    ['webkitHidden', false], ['webkitVisibilityState', 'visible']
  ]) {
    let owner = document;
    let descriptor;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, property);
      owner = Object.getPrototypeOf(owner);
    }
    if (!descriptor || !descriptor.get) continue;
    if (property === 'hidden') nativeHiddenGetter = descriptor.get;
    try {
      Object.defineProperty(document, property, {
        get: () => backgroundPlayEnabled ? visibleValue : descriptor.get.call(document),
        configurable: true
      });
    } catch (e) {}
  }
  if (nativeHasFocus) {
    try {
      Object.defineProperty(document, 'hasFocus', {
        value: () => backgroundPlayEnabled ? true : nativeHasFocus(), configurable: true
      });
    } catch (e) {}
  }
  for (const evt of ['visibilitychange', 'webkitvisibilitychange', 'blur']) {
    window.addEventListener(evt, e => {
      if (e.type === 'blur' && e.target !== window) return;
      if (e.type === 'blur') pageBlurred = true;
      if (actuallyInBackground()) rememberPlayingMedia();
      else backgroundCandidates.clear();
      if (backgroundPlayEnabled) e.stopImmediatePropagation();
    }, true);
  }
  window.addEventListener('focus', e => {
    if (e.target !== window) return;
    pageBlurred = false;
    if (!actuallyInBackground()) backgroundCandidates.clear();
  }, true);
  function pauseInteractionMedia(event) {
    if (!event.isTrusted) return null;
    const target = event.target;
    if (event.type === 'keydown') {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
          ![' ', 'Spacebar', 'k', 'K'].includes(event.key) ||
          target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '')) return null;
      return document.querySelector('video');
    }
    if (target?.tagName === 'VIDEO') return target;
    const control = target?.closest?.('button, [role="button"], .vjs-play-control');
    if (!control) return null;
    const label = control.getAttribute('aria-label') || control.getAttribute('title') || control.innerText || '';
    if (!control.classList?.contains('vjs-play-control') && !/^(?:play|pause)(?:\s|$)/i.test(label.trim())) return null;
    return control.closest?.('.video-js, .classroom-video-player, [data-test-video-player]')?.querySelector('video') ||
      document.querySelector('video');
  }

  document.addEventListener('pause', e => {
    if (lastPauseInteraction?.media === e.target && Date.now() - lastPauseInteraction.at < 1000) {
      lastPauseInteraction = null;
      userPausedMedia.add(e.target);
      e.target.setAttribute?.('data-li-user-paused', 'true');
      backgroundCandidates.delete(e.target);
      return;
    }
    if (backgroundPlayEnabled && actuallyInBackground()) recoverBackgroundPause(e.target);
  }, true);
  // Only playback controls express pause intent; Ctrl+Tab and unrelated clicks do not.
  for (const evt of ['pointerdown', 'mousedown', 'keydown']) {
    document.addEventListener(evt, e => {
      const media = pauseInteractionMedia(e);
      if (media) lastPauseInteraction = {media, at:Date.now()};
    }, true);
  }

  // Track replacement players and reset retry counts once real playback resumes.
  ['play', 'playing'].forEach(type => document.addEventListener(type, event => {
    const media = event.target;
    if (media?.tagName !== 'VIDEO') return;
    lastPauseInteraction = null;
    userPausedMedia.delete(media);
    media.removeAttribute?.('data-li-user-paused');
    if (backgroundPlayEnabled) backgroundCandidates.set(media, {attempts:0, pending:false});
  }, true));
  function prepareBackgroundMedia(media) {
    if (isQuizOrPathRoute() || !backgroundPlayEnabled || !automationPlaybackEnabled || !actuallyInBackground() ||
        media?.tagName !== 'VIDEO' || media.ended || userPausedMedia.has(media)) return;
    if (!backgroundCandidates.has(media)) backgroundCandidates.set(media, {attempts:0, pending:false});
    if (media.paused && media.readyState >= 2) recoverBackgroundPause(media);
  }
  document.addEventListener('canplay', event => prepareBackgroundMedia(event.target), true);

  // ─── 2. Pristine Native Descriptor Capture ──────────────────────────────────
  const nativeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  if (!nativeDescriptor || !nativeDescriptor.get || !nativeDescriptor.set) {
    console.error('[LI-Learn Speed Engine] Failed to obtain native playbackRate descriptor.');
    return;
  }

  // ─── 3. Event Shield: Suppress ratechange in capture phase ──────────────────
  // Stops LinkedIn's video.js/player ratechange listeners from firing and resetting the speed to 1.0!
  ['ratechange'].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      if (speedEngineEnabled && forcedSpeed > 2.0) {
        e.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener(evt, (e) => {
      if (speedEngineEnabled && forcedSpeed > 2.0) {
        e.stopImmediatePropagation();
      }
    }, true);
  });

  // ─── 4. Override playbackRate on HTMLMediaElement prototype ─────────────────
  Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
    get: function() {
      // Expose the real rate so the content watchdog does not fight the engine.
      return nativeDescriptor.get.call(this);
    },
    set: function(val) {
      if (speedEngineEnabled && forcedSpeed > 0) {
        nativeDescriptor.set.call(this, forcedSpeed);
      } else {
        nativeDescriptor.set.call(this, val);
      }
    },
    configurable: true,
    enumerable: true
  });

  // ─── 5. Per-Media Element Hooking & Safe Application ────────────────────────
  function hookMediaElement(media) {
    if (!media || media.__li_speed_hooked__) return;
    media.__li_speed_hooked__ = true;

    // Instance capture-phase ratechange shield
    media.addEventListener('ratechange', (e) => {
      if (speedEngineEnabled && forcedSpeed > 2.0) {
        e.stopImmediatePropagation();
      }
    }, true);

    // Error & buffer underrun auto-recovery: falls back to safe 2.0x then ramps back up
    media.addEventListener('error', () => {
      console.warn('[LI-Learn Speed Engine] Media buffer error detected. Temporarily backing off to 2.0x native rate...');
      if (speedEngineEnabled && forcedSpeed > 2.0) {
        try { nativeDescriptor.set.call(media, 2.0); } catch (err) {}
      }
      // Recover speed without overriding the user's pause state.
      setTimeout(() => {
        applySpeedSafely(media);
      }, 1500);
    }, true);

    // Instance property override (prevents LinkedIn from shadowing prototype on the instance)
    try {
      Object.defineProperty(media, 'playbackRate', {
        configurable: true,
        enumerable: true,
        get: function() {
          return nativeDescriptor.get.call(this);
        },
        set: function(val) {
          if (speedEngineEnabled && forcedSpeed > 0) {
            nativeDescriptor.set.call(this, forcedSpeed);
          } else {
            nativeDescriptor.set.call(this, val);
          }
        }
      });
    } catch (e) {}

    applySpeedSafely(media);
  }

  function applySpeedSafely(media) {
    if (!media || !speedEngineEnabled) return;
    try {
      const target = (speedEngineEnabled && forcedSpeed > 0) ? forcedSpeed : 1.0;

      if (media.readyState >= 1) {
        nativeDescriptor.set.call(media, target);
      }
    } catch (e) {}
  }

  function applySpeedToAll() {
    document.querySelectorAll('video, audio').forEach((media) => {
      hookMediaElement(media);
      applySpeedSafely(media);
    });
  }

  // ─── 6. Periodic Native Enforcement (Every 250ms) ───────────────────────────
  setInterval(() => {
    if (!speedEngineEnabled) return;

    document.querySelectorAll('video').forEach((media) => {
      hookMediaElement(media);
      if (media.readyState >= 1 && !media.seeking && !media.paused) {
        const currentActual = nativeDescriptor.get.call(media);
        if (Math.abs(currentActual - forcedSpeed) > 0.05) {
          try {
            nativeDescriptor.set.call(media, forcedSpeed);
          } catch (e) {}
        }
      }
    });
  }, 250);

  // Hook play & playing events so speed is enforced immediately on playback
  ['play', 'playing', 'loadedmetadata', 'canplay'].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
        hookMediaElement(e.target);
        applySpeedSafely(e.target);
      }
    }, true);
  });

  // ─── 7. Communication Bridge (Message from content script) ───────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'LI_SET_BACKGROUND_PLAY') {
      backgroundPlayEnabled = !!event.data.enabled;
      if (!backgroundPlayEnabled) backgroundCandidates.clear();
      else if (actuallyInBackground()) {
        rememberPlayingMedia();
        document.querySelectorAll('video').forEach(prepareBackgroundMedia);
      }
      return;
    }

    if (event.data.type === 'LI_SET_AUTOPLAY_STATE') {
      automationPlaybackEnabled = !!event.data.enabled;
      if (!automationPlaybackEnabled) backgroundCandidates.clear();
      else document.querySelectorAll('video').forEach(prepareBackgroundMedia);
      return;
    }

    if (event.data.type === 'LI_BACKGROUND_PULSE') {
      if (backgroundPlayEnabled && automationPlaybackEnabled) {
        rememberPlayingMedia();
        document.querySelectorAll('video').forEach(prepareBackgroundMedia);
      }
      return;
    }

    // Speed update message
    if (event.data.type === 'LI_FORCE_SPEED' || event.data.type === 'LI_SET_SPEED') {
      const speed = parseFloat(event.data.speed);
      const enabled = event.data.enabled !== undefined ? !!event.data.enabled : true;

      speedEngineEnabled = enabled;
      forcedSpeed = Number.isFinite(speed) ? Math.min(16.0, Math.max(0.25, speed)) : 1.0;

      if (!enabled) {
        document.querySelectorAll('video, audio').forEach((media) => {
          try { nativeDescriptor.set.call(media, 1); } catch (e) {}
        });
      } else {
        applySpeedToAll();
      }
    }
  });

  // ─── 8. Direct Inspection & Verification Hook ────────────────────────────────
  window.__liSpeedEngine = {
    getForcedSpeed: () => forcedSpeed,
    isEnabled: () => speedEngineEnabled,
    getNativePlaybackRate: () => {
      const v = document.querySelector('video');
      return v && nativeDescriptor ? nativeDescriptor.get.call(v) : null;
    },
    setSpeed: (speed, enabled = true) => {
      speedEngineEnabled = !!enabled;
      forcedSpeed = Math.min(16.0, Math.max(0.25, parseFloat(speed) || 1.0));
      applySpeedToAll();
      console.log(`[LI-Learn Speed Engine] Manually set to ${forcedSpeed}x (Native rate: ${window.__liSpeedEngine.getNativePlaybackRate()})`);
    }
  };

  // Initial pass on existing media
  applySpeedToAll();

  console.log('[LI-Learn] Main World 16x Speed Engine & React Event Bridge Active.');
})();

