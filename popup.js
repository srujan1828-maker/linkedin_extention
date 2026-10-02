/**
 * popup.js — LinkedIn Learning AI AutoPilot Controller (v10.2)
 *
 * Implements Coursera AutoPilot architecture:
 *  - 3-Tab Interface: Controls, AI Solution Viewer, and Activity & Error Logs
 *  - Speed Injection Engine: 0.25x – 16.0x with rapid presets
 *  - Focus Mode Selector: all, videos_only, quizzes_only, pending_only
 *  - Multi-Provider AI Dispatcher with dynamic model discovery & real-time cooldown tracking
 *  - Live Quiz Solution display with marked answers and AI reasoning
 *  - Monospace real-time activity and progress logging
 */

document.addEventListener('DOMContentLoaded', () => {
  const versionText = document.getElementById('versionText');
  if (versionText) {
    try {
      versionText.innerText = 'v' + chrome.runtime.getManifest().version;
    } catch (e) {}
  }

  // ─── DOM References ─────────────────────────────────────────────────────────

  // Navigation Tabs
  const tabBtns = document.querySelectorAll('.tab-btn');
  const panes = {
    settings: document.getElementById('pane-settings'),
    quiz: document.getElementById('pane-quiz'),
    logs: document.getElementById('pane-logs')
  };
  const quizBadge = document.getElementById('quizBadge');

  // Controls & Action Buttons
  const btnBulkComplete = document.getElementById('btn-bulk-complete');
  const btnSolveQuiz = document.getElementById('btn-solve-quiz');
  const btnStopBulk = document.getElementById('btn-stop-bulk');

  // Progress Bar
  const bulkProgressContainer = document.getElementById('bulk-progress-container');
  const bulkProgressPct = document.getElementById('bulk-progress-pct');
  const bulkProgressMsg = document.getElementById('bulk-progress-msg');
  const bulkProgressBar = document.getElementById('bulk-progress-bar');

  // Speed & Focus Mode Controls
  const speedInjectionCB = document.getElementById('speedInjectionCB');
  const speedToggleStatus = document.getElementById('speedToggleStatus');
  const speedInputWrapper = document.getElementById('speedInputWrapper');
  const speedInput = document.getElementById('speedInput');
  const focusModeSelect = document.getElementById('focusModeSelect');

  // AI Provider & Cooldowns
  const providerSelect = document.getElementById('providerSelect');
  const resetCooldownsBtn = document.getElementById('resetCooldownsBtn');
  const chips = {
    groq: document.getElementById('chip-groq'),
    gemini: document.getElementById('chip-gemini'),
    openrouter: document.getElementById('chip-openrouter'),
    nvidia: document.getElementById('chip-nvidia')
  };

  // Keys Drawer
  const toggleKeysBtn = document.getElementById('toggleKeysBtn');
  const keysDrawer = document.getElementById('keysDrawer');
  const keysArrow = document.getElementById('keysArrow');
  const groqApiKeyInput = document.getElementById('groqApiKeyInput');
  const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
  const openRouterApiKeyInput = document.getElementById('openRouterApiKeyInput');
  const nvidiaApiKeyInput = document.getElementById('nvidiaApiKeyInput');

  // Automation Checkboxes
  const strictCompletionCB = document.getElementById('strictCompletionCB');
  const autoSolveCB = document.getElementById('autoSolveCB');
  const bgPlayCB = document.getElementById('bgPlayCB');
  const autoNavigateCB = document.getElementById('autoNavigateCB');

  // Panes: Quiz Solution & Logs
  const quizSolutionContainer = document.getElementById('quizSolutionContainer');
  const logList = document.getElementById('logList');
  const clearLogsBtn = document.getElementById('clearLogsBtn');

  const SPEED_MIN = 0.25;
  const SPEED_MAX = 16.0;

  function sanitizeSpeed(val) {
    const num = parseFloat(val);
    if (isNaN(num) || num < SPEED_MIN) return 1.0;
    return Math.min(Math.max(num, SPEED_MIN), SPEED_MAX);
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─── Tab Switching ──────────────────────────────────────────────────────────

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      Object.keys(panes).forEach((k) => {
        if (panes[k]) {
          if (k === targetTab) panes[k].classList.add('active');
          else panes[k].classList.remove('active');
        }
      });
    });
  });

  // ─── Collapsible Keys Drawer ────────────────────────────────────────────────

  let keysOpen = false;
  if (toggleKeysBtn && keysDrawer) {
    toggleKeysBtn.addEventListener('click', () => {
      keysOpen = !keysOpen;
      keysDrawer.style.display = keysOpen ? 'flex' : 'none';
      if (keysArrow) keysArrow.innerText = keysOpen ? '▲' : '▼';
    });
  }

  // ─── Speed UI Updates ───────────────────────────────────────────────────────

  function updateSpeedInjectionUI(enabled) {
    if (!speedToggleStatus) return;
    if (enabled) {
      speedToggleStatus.innerText = 'ENABLED';
      speedToggleStatus.style.color = '#34d399';
      speedToggleStatus.style.background = 'rgba(16, 185, 129, 0.15)';
      speedToggleStatus.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      if (speedInputWrapper) {
        speedInputWrapper.style.opacity = '1';
        speedInputWrapper.style.pointerEvents = 'auto';
      }
    } else {
      speedToggleStatus.innerText = 'OFF (Native)';
      speedToggleStatus.style.color = '#f59e0b';
      speedToggleStatus.style.background = 'rgba(245, 158, 11, 0.15)';
      speedToggleStatus.style.borderColor = 'rgba(245, 158, 11, 0.3)';
      if (speedInputWrapper) {
        speedInputWrapper.style.opacity = '0.45';
        speedInputWrapper.style.pointerEvents = 'none';
      }
    }
  }

  // ─── Provider Status & Cooldown Chips ───────────────────────────────────────

  function updateProviderChips(data) {
    const keys = {
      groq: (data.groqApiKey || '').trim(),
      gemini: (data.geminiApiKey || '').trim(),
      openrouter: (data.openRouterApiKey || '').trim(),
      nvidia: (data.nvidiaApiKey || '').trim()
    };

    const cooldowns = data.providerCooldowns || {};
    const now = Date.now();

    const providerNames = {
      groq: 'Groq',
      gemini: 'Gemini',
      openrouter: 'OpenRouter',
      nvidia: 'NVIDIA'
    };

    Object.keys(chips).forEach((pId) => {
      const chip = chips[pId];
      if (!chip) return;

      const hasKey = !!keys[pId];
      const cdUntil = cooldowns[pId] || 0;
      const isCooldown = now < cdUntil;

      chip.className = 'status-chip';

      if (!hasKey) {
        chip.classList.add('unset');
        chip.innerHTML = `<span>${providerNames[pId]}</span><span class="chip-state">Not Set</span>`;
      } else if (isCooldown) {
        const remaining = Math.max(1, Math.ceil((cdUntil - now) / 1000));
        chip.style.background = 'rgba(245, 158, 11, 0.15)';
        chip.style.color = '#fbbf24';
        chip.style.border = '1px solid rgba(245, 158, 11, 0.3)';
        chip.innerHTML = `<span>${providerNames[pId]}</span><span class="chip-state">⏳ ${remaining}s</span>`;
      } else {
        chip.classList.add('ready');
        chip.style.background = 'rgba(16, 185, 129, 0.15)';
        chip.style.color = '#34d399';
        chip.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        chip.innerHTML = `<span>${providerNames[pId]}</span><span class="chip-state">● Ready</span>`;
      }
    });
  }

  // ─── AI Solution Viewer Renderer ────────────────────────────────────────────

  function renderQuizSolution(data) {
    if (!quizSolutionContainer) return;
    if (!data || !Array.isArray(data.questions) || data.questions.length === 0) {
      quizSolutionContainer.innerHTML = `
        <div class="quiz-empty">
          <div class="quiz-empty-icon">🧠</div>
          No quiz solved yet.<br>
          Navigate to any quiz on LinkedIn Learning to view live AI answers, step-by-step reasoning, and marked choices right here!
        </div>
      `;
      if (quizBadge) quizBadge.classList.remove('active');
      return;
    }

    if (quizBadge) quizBadge.classList.add('active');

    const title = data.title || 'LinkedIn Learning Quiz';
    const time = data.timestamp || '';
    const providerTag = data.providerUsed
      ? `<span style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 2px 7px; border-radius: 4px; font-weight: 700; font-size: 10px; margin-left: 6px;">${escapeHtml(data.providerUsed)}</span>`
      : '';

    let html = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; padding-bottom: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
        <div>
          <span style="font-weight: 700; font-size: 12px; color: #f8fafc;" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
          ${providerTag}
        </div>
        <span style="font-size: 10px; color: #94a3b8;">⏱ ${escapeHtml(time)}</span>
      </div>
    `;

    data.questions.forEach((q, idx) => {
      const isSingle = q.type !== 'checkbox';
      const promptText = q.prompt || `Question ${idx + 1}`;
      html += `
        <div class="solution-card">
          <div class="solution-counter">
            <span>QUESTION ${idx + 1}</span>
            <span style="color: #94a3b8; font-size: 9.5px;">${isSingle ? 'Single Choice' : 'Multiple Choice'}</span>
          </div>
          <div class="solution-prompt">${escapeHtml(promptText)}</div>
          <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 6px;">
      `;

      (q.options || []).forEach((optText, oIdx) => {
        const isSelected = Array.isArray(q.markedIndex)
          ? q.markedIndex.includes(oIdx)
          : q.markedIndex === oIdx;

        if (isSelected) {
          html += `
            <div class="solution-choice">
              <span>${isSingle ? '●' : '☑'} ${escapeHtml(optText)}</span>
              <span style="font-size: 9px; margin-left: 6px; background: rgba(16, 185, 129, 0.3); padding: 1px 4px; border-radius: 3px;">✓ AI Choice</span>
            </div>
          `;
        } else {
          html += `
            <div style="padding: 5px 8px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 5px; color: #94a3b8; font-size: 11px;">
              <span>${isSingle ? '○' : '☐'} ${escapeHtml(optText)}</span>
            </div>
          `;
        }
      });

      html += `</div>`;

      if (q.aiRationale) {
        html += `
          <div class="solution-rationale">
            <strong style="color: #38bdf8; font-style: normal;">💡 AI Reasoning:</strong> ${escapeHtml(q.aiRationale)}
          </div>
        `;
      }

      html += `</div>`;
    });

    if (data.rawResponse) {
      html += `
        <div style="margin-top: 8px;">
          <button type="button" id="toggleRawBtn" style="background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1); color: #94a3b8; font-size: 10px; padding: 4px 8px; border-radius: 4px; cursor: pointer; width: 100%;">🔍 View Raw AI Response &amp; Prompt</button>
          <div id="rawContent" style="display: none; background: #090d1a; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px; margin-top: 6px; font-family: monospace; font-size: 10px; color: #cbd5e1; white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow-y: auto;">
<strong>Prompt Sent:</strong>
${escapeHtml(data.rawPrompt || '')}

<strong>AI Response:</strong>
${escapeHtml(data.rawResponse || '')}
          </div>
        </div>
      `;
    }

    quizSolutionContainer.innerHTML = html;

    const toggleBtn = document.getElementById('toggleRawBtn');
    const rawContent = document.getElementById('rawContent');
    if (toggleBtn && rawContent) {
      toggleBtn.addEventListener('click', () => {
        const isVisible = rawContent.style.display === 'block';
        rawContent.style.display = isVisible ? 'none' : 'block';
        toggleBtn.innerText = isVisible ? '🔍 View Raw AI Response & Prompt' : '✕ Hide Raw AI Response';
      });
    }
  }

  // ─── Activity & Error Logs Renderer ─────────────────────────────────────────

  function renderLogs(logs) {
    if (!logList) return;
    if (!Array.isArray(logs) || logs.length === 0) {
      logList.innerHTML = '<div style="color: #64748b; text-align: center; padding: 12px 0;">No activity recorded yet.</div>';
      return;
    }

    logList.innerHTML = logs
      .map((item) => {
        const type = item.type || 'info';
        const time = item.time || '';
        const msg = escapeHtml(item.message || '');
        return `
          <div class="log-item">
            <span class="log-time">[${time}]</span>
            <span class="log-msg ${type}">${msg}</span>
          </div>
        `;
      })
      .join('');
  }

  // ─── Progress Bar Updates ───────────────────────────────────────────────────

  function updateProgressBar(percent, message) {
    if (!bulkProgressContainer) return;
    bulkProgressContainer.style.display = 'block';
    if (bulkProgressBar) bulkProgressBar.style.width = `${percent}%`;
    if (bulkProgressPct) bulkProgressPct.textContent = `${percent}%`;
    if (bulkProgressMsg && message) bulkProgressMsg.textContent = message;

    if (btnBulkComplete) {
      btnBulkComplete.disabled = percent < 100 && percent > 0;
    }
  }

  function hideProgressBar() {
    if (bulkProgressContainer) bulkProgressContainer.style.display = 'none';
    if (btnBulkComplete) btnBulkComplete.disabled = false;
  }

  // ─── Active Tab Communication ───────────────────────────────────────────────

  async function getActiveLinkedInTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/linkedin\.com/i.test(tab.url)) {
      return null;
    }
    return tab;
  }

  async function sendToContent(msg) {
    const tab = await getActiveLinkedInTab();
    if (!tab) {
      return null;
    }
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return null;
    }
  }

  // ─── Load Saved Storage & Initialize ────────────────────────────────────────

  let cachedStorage = {};

  function refreshStorage() {
    chrome.storage.local.get(
      [
        'speedInjection',
        'playbackSpeed',
        'focusMode',
        'preferredProvider',
        'geminiApiKey',
        'groqApiKey',
        'openRouterApiKey',
        'nvidiaApiKey',
        'strictCompletion',
        'autoSolve',
        'autoSolveQuizzes',
        'bgPlay',
        'autoNavigate',
        'activityLogs',
        'lastGeminiQuizData',
        'lastQuizSolution',
        'providerCooldowns',
        'bulkActive'
      ],
      (data) => {
        cachedStorage = data;

        // Speed Injection
        const isSpeedEnabled = data.speedInjection !== undefined ? !!data.speedInjection : true;
        if (speedInjectionCB) {
          speedInjectionCB.checked = isSpeedEnabled;
          updateSpeedInjectionUI(isSpeedEnabled);
        }

        const currentSpeed = data.playbackSpeed !== undefined ? sanitizeSpeed(data.playbackSpeed) : 16.0;
        if (speedInput) speedInput.value = currentSpeed;

        // Highlight matching preset button
        document.querySelectorAll('.speed-preset-btn').forEach((btn) => {
          const s = parseFloat(btn.dataset.speed);
          btn.classList.toggle('active', s === currentSpeed);
        });

        // Focus Mode (defaults to 'pending_only' per user request)
        if (focusModeSelect) {
          focusModeSelect.value = data.focusMode || 'pending_only';
        }

        // Provider Selector
        if (providerSelect) {
          providerSelect.value = data.preferredProvider || 'auto';
        }

        // Keys Inputs
        if (groqApiKeyInput) groqApiKeyInput.value = data.groqApiKey || '';
        if (geminiApiKeyInput) geminiApiKeyInput.value = data.geminiApiKey || '';
        if (openRouterApiKeyInput) openRouterApiKeyInput.value = data.openRouterApiKey || '';
        if (nvidiaApiKeyInput) nvidiaApiKeyInput.value = data.nvidiaApiKey || '';

        // Auto-open keys drawer if no keys are configured
        const hasAnyKey = !!(data.groqApiKey || data.geminiApiKey || data.openRouterApiKey || data.nvidiaApiKey);
        if (!hasAnyKey && keysDrawer) {
          keysOpen = true;
          keysDrawer.style.display = 'flex';
          if (keysArrow) keysArrow.innerText = '▲';
        }

        // Automation Checkboxes
        if (strictCompletionCB) strictCompletionCB.checked = data.strictCompletion !== undefined ? data.strictCompletion : true;
        if (autoSolveCB) autoSolveCB.checked = (data.autoSolve !== undefined ? data.autoSolve : (data.autoSolveQuizzes !== undefined ? data.autoSolveQuizzes : true));
        if (bgPlayCB) bgPlayCB.checked = data.bgPlay !== undefined ? data.bgPlay : true;
        if (autoNavigateCB) autoNavigateCB.checked = data.autoNavigate !== undefined ? data.autoNavigate : true;

        // Render Status Chips, Solution, and Logs
        updateProviderChips(data);
        renderLogs(data.activityLogs);
        renderQuizSolution(data.lastQuizSolution || data.lastGeminiQuizData);

        // Progress bar state if already running
        if (data.bulkActive) {
          updateProgressBar(0, 'LinkedIn AutoPilot running in background...');
        }
      }
    );
  }

  refreshStorage();

  // 1-second interval to update chip cooldown countdowns visually
  setInterval(() => {
    if (cachedStorage) {
      updateProviderChips(cachedStorage);
    }
  }, 1000);

  // ─── Listen for Real-Time Storage Changes ───────────────────────────────────

  chrome.storage.onChanged.addListener((changes) => {
    Object.keys(changes).forEach((k) => {
      cachedStorage[k] = changes[k].newValue;
    });

    if (changes.speedInjection !== undefined && speedInjectionCB) {
      const isEnabled = !!changes.speedInjection.newValue;
      speedInjectionCB.checked = isEnabled;
      updateSpeedInjectionUI(isEnabled);
    }

    if (changes.playbackSpeed !== undefined && speedInput) {
      const spd = sanitizeSpeed(changes.playbackSpeed.newValue);
      speedInput.value = spd;
      document.querySelectorAll('.speed-preset-btn').forEach((btn) => {
        btn.classList.toggle('active', parseFloat(btn.dataset.speed) === spd);
      });
    }

    if (changes.focusMode && focusModeSelect) {
      focusModeSelect.value = changes.focusMode.newValue || 'videos_only';
    }

    if (changes.preferredProvider && providerSelect) {
      providerSelect.value = changes.preferredProvider.newValue || 'auto';
    }

    if (changes.activityLogs) renderLogs(changes.activityLogs.newValue);
    if (changes.lastQuizSolution || changes.lastGeminiQuizData) {
      renderQuizSolution(changes.lastQuizSolution?.newValue || changes.lastGeminiQuizData?.newValue);
    }

    if (changes.providerCooldowns || changes.groqApiKey || changes.geminiApiKey || changes.openRouterApiKey || changes.nvidiaApiKey) {
      updateProviderChips(cachedStorage);
    }

    if (changes.bulkActive !== undefined) {
      if (!changes.bulkActive.newValue) {
        hideProgressBar();
      }
    }
  });

  // ─── Listen for Runtime Progress Messages ───────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'bulkProgress') {
      if (message.error) {
        hideProgressBar();
        return;
      }
      if (message.stopped) {
        hideProgressBar();
        return;
      }
      const pct = typeof message.percent === 'number' ? message.percent : 0;
      updateProgressBar(pct, message.message);
      if (message.isDone) {
        setTimeout(hideProgressBar, 4000);
      }
    }
  });

  // ─── Event Handlers: Speed & Presets ────────────────────────────────────────

  if (speedInjectionCB) {
    speedInjectionCB.addEventListener('change', () => {
      const isEnabled = speedInjectionCB.checked;
      chrome.storage.local.set({ speedInjection: isEnabled });
      updateSpeedInjectionUI(isEnabled);
      sendToContent({ action: 'setSpeedInjection', enabled: isEnabled });
    });
  }

  function saveSpeed() {
    const clean = sanitizeSpeed(speedInput.value);
    speedInput.value = clean;
    chrome.storage.local.set({ playbackSpeed: clean });
    sendToContent({ action: 'setSpeed', speed: clean });
  }

  if (speedInput) {
    speedInput.addEventListener('change', saveSpeed);
    speedInput.addEventListener('blur', saveSpeed);
  }

  document.querySelectorAll('.speed-preset-btn').forEach((btn) => {
    if (!btn.dataset.speed) return;
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.dataset.speed) || 16.0;
      if (speedInput) speedInput.value = speed;
      chrome.storage.local.set({ playbackSpeed: speed, speedInjection: true });
      if (speedInjectionCB) {
        speedInjectionCB.checked = true;
        updateSpeedInjectionUI(true);
      }
      document.querySelectorAll('.speed-preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      sendToContent({ action: 'setSpeed', speed });
    });
  });

  // ─── Focus Mode & Automation Checkboxes ─────────────────────────────────────

  if (focusModeSelect) {
    focusModeSelect.addEventListener('change', () => {
      const val = focusModeSelect.value;
      chrome.storage.local.set({ focusMode: val });
      sendToContent({ action: 'setFocusMode', focusMode: val });
    });
  }

  if (strictCompletionCB) {
    strictCompletionCB.addEventListener('change', () => {
      chrome.storage.local.set({ strictCompletion: strictCompletionCB.checked });
      sendToContent({ action: 'setStrictCompletion', enabled: strictCompletionCB.checked });
    });
  }

  if (autoSolveCB) {
    autoSolveCB.addEventListener('change', () => {
      const checked = autoSolveCB.checked;
      chrome.storage.local.set({ autoSolve: checked, autoSolveQuizzes: checked });
      sendToContent({ action: 'setAutoSolveQuizzes', enabled: checked });
    });
  }

  if (bgPlayCB) {
    bgPlayCB.addEventListener('change', () => {
      chrome.storage.local.set({ bgPlay: bgPlayCB.checked });
      sendToContent({ action: 'setBgPlay', enabled: bgPlayCB.checked });
    });
  }

  if (autoNavigateCB) {
    autoNavigateCB.addEventListener('change', () => {
      chrome.storage.local.set({ autoNavigate: autoNavigateCB.checked });
      sendToContent({ action: 'setAutoNavigate', enabled: autoNavigateCB.checked });
    });
  }

  // ─── AI Provider & Reset Cooldowns ──────────────────────────────────────────

  if (providerSelect) {
    providerSelect.addEventListener('change', () => {
      chrome.storage.local.set({ preferredProvider: providerSelect.value });
    });
  }

  if (resetCooldownsBtn) {
    resetCooldownsBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'RESET_COOLDOWNS' }, () => {
        cachedStorage.providerCooldowns = {};
        updateProviderChips(cachedStorage);
      });
    });
  }

  // ─── API Key Inputs Live Auto-Save ──────────────────────────────────────────

  const bindKeyInput = (el, storageKey) => {
    if (!el) return;
    const save = () => {
      const val = el.value.trim();
      chrome.storage.local.set({ [storageKey]: val }, () => {
        chrome.storage.local.get(['groqApiKey', 'geminiApiKey', 'openRouterApiKey', 'nvidiaApiKey', 'providerCooldowns'], updateProviderChips);
      });
    };
    el.addEventListener('input', save);
    el.addEventListener('change', save);
  };

  bindKeyInput(groqApiKeyInput, 'groqApiKey');
  bindKeyInput(geminiApiKeyInput, 'geminiApiKey');
  bindKeyInput(openRouterApiKeyInput, 'openRouterApiKey');
  bindKeyInput(nvidiaApiKeyInput, 'nvidiaApiKey');

  // ─── Action Buttons: AutoPilot, Solve Quiz, Stop ────────────────────────────

  if (btnBulkComplete) {
    btnBulkComplete.addEventListener('click', async () => {
      const focusMode = focusModeSelect?.value || 'pending_only';
      const speed = sanitizeSpeed(speedInput?.value || 16.0);
      updateProgressBar(0, `Scanning course syllabus (Mode: ${focusMode})...`);

      const res = await sendToContent({
        action: 'startBulkComplete',
        focusMode,
        speed
      });

      if (!res || !res.success) {
        chrome.storage.local.get(['activityLogs'], (d) => {
          const logs = d.activityLogs || [];
          logs.unshift({
            time: new Date().toLocaleTimeString(),
            message: 'Ensure you are on an active LinkedIn Learning course page before running AutoPilot.',
            type: 'error'
          });
          chrome.storage.local.set({ activityLogs: logs });
          renderLogs(logs);
        });
        hideProgressBar();
      }
    });
  }

  if (btnStopBulk) {
    btnStopBulk.addEventListener('click', async () => {
      await sendToContent({ action: 'stopBulkComplete' });
      await chrome.storage.local.set({ bulkActive: false });
      hideProgressBar();
    });
  }

  if (btnSolveQuiz) {
    btnSolveQuiz.addEventListener('click', async () => {
      const data = await chrome.storage.local.get(['groqApiKey', 'geminiApiKey', 'openRouterApiKey', 'nvidiaApiKey']);
      const hasKey = ['groqApiKey', 'geminiApiKey', 'openRouterApiKey', 'nvidiaApiKey'].some((k) => !!(data[k] && data[k].trim()));

      if (!hasKey) {
        if (keysDrawer && keysDrawer.style.display !== 'flex') {
          keysOpen = true;
          keysDrawer.style.display = 'flex';
          if (keysArrow) keysArrow.innerText = '▲';
        }
        if (groqApiKeyInput) groqApiKeyInput.focus();
        chrome.storage.local.get(['activityLogs'], (d) => {
          const logs = d.activityLogs || [];
          logs.unshift({
            time: new Date().toLocaleTimeString(),
            message: 'Please enter a free Groq or Gemini API key in the keys drawer to solve quizzes.',
            type: 'warn'
          });
          chrome.storage.local.set({ activityLogs: logs });
          renderLogs(logs);
        });
        return;
      }

      btnSolveQuiz.disabled = true;
      btnSolveQuiz.innerText = '🧠 Solving Quiz with AI...';

      const res = await sendToContent({ action: 'solveQuizNow' });

      btnSolveQuiz.disabled = false;
      btnSolveQuiz.innerHTML = '<span>🧠 Solve Current Quiz (AI)</span>';

      if (res && res.success) {
        // Automatically switch to the "🧠 AI Solution" tab so user can review answers!
        const quizTabBtn = document.querySelector('.tab-btn[data-tab="quiz"]');
        if (quizTabBtn) quizTabBtn.click();
      }
    });
  }

  // ─── Clear Logs Button ──────────────────────────────────────────────────────

  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', () => {
      chrome.storage.local.set({ activityLogs: [] }, () => {
        renderLogs([]);
      });
    });
  }
});
