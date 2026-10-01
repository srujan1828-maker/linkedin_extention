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

  let forcedSpeed = 16.0;
  let speedEngineEnabled = true;

  // ─── 1. Page Visibility API Bypass ──────────────────────────────────────────
  try {
    Object.defineProperty(document, 'hidden', {
      get: () => false,
      configurable: true
    });
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible',
      configurable: true
    });
    Object.defineProperty(document, 'webkitHidden', {
      get: () => false,
      configurable: true
    });
    Object.defineProperty(document, 'webkitVisibilityState', {
      get: () => 'visible',
      configurable: true
    });
  } catch (e) {}

  ['visibilitychange', 'webkitvisibilitychange'].forEach((evt) => {
    window.addEventListener(evt, (e) => e.stopImmediatePropagation(), true);
    document.addEventListener(evt, (e) => e.stopImmediatePropagation(), true);
  });
  window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);

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
      // When forced speed is above LinkedIn's 2.0x limit, report 2.0x
      // This satisfies LinkedIn's player UI/state machine completely without triggering resets
      if (speedEngineEnabled && forcedSpeed > 2.0) {
        return 2.0;
      }
      return nativeDescriptor.get.call(this);
    },
    set: function(val) {
      if (speedEngineEnabled && forcedSpeed > 1.0) {
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
      if (forcedSpeed > 2.0) {
        try { nativeDescriptor.set.call(media, 2.0); } catch (err) {}
      }
      try { media.play().catch(() => {}); } catch (err) {}
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
          if (speedEngineEnabled && forcedSpeed > 2.0) return 2.0;
          return nativeDescriptor.get.call(this);
        },
        set: function(val) {
          if (speedEngineEnabled && forcedSpeed > 1.0) {
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
    if (!media) return;
    try {
      const target = (speedEngineEnabled && forcedSpeed > 0) ? forcedSpeed : 1.0;

      // Auto-configure audio pipeline for high rates
      if (target > 2.0) {
        media.preservesPitch = false;
        media.webkitPreservesPitch = false;
        media.mozPreservesPitch = false;
        if (!media.muted) {
          media.muted = true;
        }
      }

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
    if (!speedEngineEnabled || forcedSpeed <= 1.0) return;

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
    if (!event.data) return;

    // Speed update message
    if (event.data.type === 'LI_FORCE_SPEED' || event.data.type === 'LI_SET_SPEED') {
      const speed = parseFloat(event.data.speed);
      const enabled = event.data.enabled !== undefined ? !!event.data.enabled : true;

      speedEngineEnabled = enabled;
      if (!enabled || isNaN(speed) || speed <= 1.0) {
        forcedSpeed = 1.0;
      } else {
        forcedSpeed = Math.min(16.0, Math.max(0.25, speed));
      }

      applySpeedToAll();
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
