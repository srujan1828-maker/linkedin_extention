/**
 * background.js — LinkedIn Learning Automation Service Worker & Multi-Provider AI Dispatcher
 *
 * Implements the exact AI auto-solving mechanism from Coursera AutoPilot:
 *  - Google Gemini (dynamic model discovery, priority fallback: 1.5-flash, 2.0-flash, 1.5-flash-8b, etc.)
 *  - Groq Cloud (ultra-fast, llama-3.3-70b-versatile, llama-3.1-8b-instant, etc.)
 *  - OpenRouter (free models: llama-3.3-70b-instruct:free, gemini-2.0-flash-exp:free, etc.)
 *  - NVIDIA NIM (meta/llama-3.1-70b-instruct, etc.)
 *  - Automatic multi-model failover, rate-limit cooldown management, and in-flight request deduplication.
 */

// ─── AI Provider Registry ─────────────────────────────────────────────────────

const PROVIDERS = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    storageKey: 'geminiApiKey',
    call: callGemini
  },
  groq: {
    id: 'groq',
    name: 'Groq Cloud',
    storageKey: 'groqApiKey',
    call: callGroq
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter (Free)',
    storageKey: 'openRouterApiKey',
    call: callOpenRouter
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    storageKey: 'nvidiaApiKey',
    call: callNvidia
  }
};

// ─── 1. Google Gemini Provider ────────────────────────────────────────────────

async function discoverGeminiModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => (m.name.startsWith('models/') ? m.name : `models/${m.name}`));
    if (models.length > 0) return models;
  } catch (e) {}
  return null;
}

async function getGeminiCandidateModels(apiKey) {
  const priorityFallbacks = [
    'models/gemini-1.5-flash',
    'models/gemini-2.0-flash',
    'models/gemini-1.5-flash-8b',
    'models/gemini-2.0-flash-lite',
    'models/gemini-1.5-pro',
    'models/gemini-2.5-flash'
  ];

  try {
    const discovered = await discoverGeminiModels(apiKey);
    if (discovered && discovered.length > 0) {
      const sorted = [];
      const priorityPatterns = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro'];
      for (const pat of priorityPatterns) {
        const matches = discovered.filter((m) => m.includes(pat));
        for (const m of matches) {
          if (!sorted.includes(m)) sorted.push(m);
        }
      }
      for (const m of discovered) {
        if (!sorted.includes(m)) sorted.push(m);
      }
      if (sorted.length > 0) return sorted;
    }
  } catch (e) {}

  return priorityFallbacks;
}

async function callSingleGemini(modelName, apiKey, prompt, useJsonMime = true) {
  const cleanModel = modelName.startsWith('models/') ? modelName : `models/${modelName}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${cleanModel}:generateContent?key=${apiKey}`;

  const bodyPayload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
  };

  if (useJsonMime) {
    bodyPayload.generationConfig.responseMimeType = 'application/json';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify(bodyPayload)
  });

  const status = response.status;
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status, data };
}

async function callGemini(apiKey, prompt) {
  const candidateModels = await getGeminiCandidateModels(apiKey);
  let lastError = null;

  for (const model of candidateModels) {
    try {
      const shortModel = model.replace('models/', '');

      let res = await callSingleGemini(model, apiKey, prompt, true);
      if (!res.ok && res.status === 400) {
        res = await callSingleGemini(model, apiKey, prompt, false);
      }

      if (res.ok) {
        const textPart = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (textPart) {
          return { ok: true, text: textPart, modelUsed: `Gemini (${shortModel})` };
        }
      }

      lastError = { status: res.status, message: res.data?.error?.message || `HTTP ${res.status}` };

      // Quota 429, not found 404, or server error -> try next candidate model
      if (res.status === 429 || res.status === 404 || res.status === 500 || res.status === 503) {
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        break;
      }
    } catch (e) {
      lastError = { status: 0, message: e.message };
    }
  }

  return { ok: false, status: lastError?.status || 500, error: lastError?.message || 'All Gemini models failed' };
}

// ─── 2. Groq Cloud Provider ───────────────────────────────────────────────────

async function discoverGroqModels(apiKey) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      const models = (data.data || []).map((m) => m.id);
      if (models.length > 0) return models;
    }
  } catch (e) {}
  return null;
}

async function getGroqCandidateModels(apiKey) {
  // Active text chat models on Groq in strict priority order:
  // 1. openai/gpt-oss-120b: flagship reasoning, ultra-fast (~450ms)
  // 2. openai/gpt-oss-20b: lightweight high-throughput (~700ms)
  // 3. qwen/qwen3.8-27b: Alibaba Qwen on Groq (~490ms)
  // 4. allam-2-7b: compact multilingual
  const priorityList = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'allam-2-7b'
  ];

  try {
    const discovered = await discoverGroqModels(apiKey);
    if (discovered && discovered.length > 0) {
      // Strictly exclude audio, guard, terms-locked (orpheus), or safeguard classifier models
      const eligible = discovered.filter((m) => {
        const lower = m.toLowerCase();
        if (/whisper|guard|safeguard|orpheus|audio|vision|embed|moderation/i.test(lower)) {
          return false;
        }
        return true;
      });

      const sorted = [];
      for (const p of priorityList) {
        if (eligible.includes(p)) sorted.push(p);
      }
      for (const m of eligible) {
        if (!sorted.includes(m)) sorted.push(m);
      }
      if (sorted.length > 0) return sorted;
    }
  } catch (e) {}

  return priorityList;
}

async function callGroq(apiKey, prompt) {
  const groqModels = await getGroqCandidateModels(apiKey);
  let lastError = null;

  for (const model of groqModels) {
    try {
      const url = 'https://api.groq.com/openai/v1/chat/completions';
      const bodyPayload = {
        model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert academic quiz solver. Output ONLY a valid JSON object matching the requested schema without Markdown formatting.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: 'json_object' }
      };

      let response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify(bodyPayload)
      });

      let status = response.status;
      let data = await response.json().catch(() => ({}));

      // If model does not support response_format { type: 'json_object' }, retry without it
      if (!response.ok && status === 400 && data.error?.message?.includes('response_format')) {
        delete bodyPayload.response_format;
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify(bodyPayload)
        });
        status = response.status;
        data = await response.json().catch(() => ({}));
      }

      if (response.ok) {
        const text = data.choices?.[0]?.message?.content;
        if (text) {
          return { ok: true, text, modelUsed: `Groq (${model})` };
        }
      }

      lastError = { status, message: data.error?.message || `HTTP ${status}` };

      // If model hits 400 (terms, size), 404, 410, 422, 429 (rate-limit), 500, or 503,
      // silently proceed to next Groq candidate model without failing provider!
      if (status === 400 || status === 404 || status === 410 || status === 422 || status === 429 || status === 500 || status === 503) {
        continue;
      }
      if (status === 401 || status === 403) break;
    } catch (e) {
      lastError = { status: 0, message: e.message };
    }
  }

  return { ok: false, status: lastError?.status || 500, error: lastError?.message || 'All Groq models failed' };
}

// ─── 3. OpenRouter Provider ───────────────────────────────────────────────────

async function discoverOpenRouterFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      const models = (data.data || []).map((m) => m.id).filter((id) => id.endsWith(':free'));
      if (models.length > 0) return models;
    }
  } catch (e) {}
  return null;
}

async function getOpenRouterCandidateModels() {
  const defaultList = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'deepseek/deepseek-r1:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'meta-llama/llama-3.1-8b-instruct:free'
  ];

  try {
    const discovered = await discoverOpenRouterFreeModels();
    if (discovered && discovered.length > 0) {
      const sorted = [];
      for (const m of defaultList) {
        if (discovered.includes(m)) sorted.push(m);
      }
      for (const m of discovered) {
        if (!sorted.includes(m)) sorted.push(m);
      }
      if (sorted.length > 0) return sorted;
    }
  } catch (e) {}

  return defaultList;
}

async function callOpenRouter(apiKey, prompt) {
  const freeModels = await getOpenRouterCandidateModels();
  let lastError = null;

  for (const model of freeModels) {
    try {
      const url = 'https://openrouter.ai/api/v1/chat/completions';
      const bodyPayload = {
        model,
        messages: [
          { role: 'system', content: 'You are an expert academic quiz solver. Output ONLY a valid JSON object matching the requested schema without Markdown formatting.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 1024
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://www.linkedin.com/learning',
          'X-Title': 'LinkedIn Learning AI AutoPilot'
        },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify(bodyPayload)
      });

      const status = response.status;
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const text = data.choices?.[0]?.message?.content;
        if (text) {
          const shortName = model.split('/')[1]?.replace(':free', '') || model;
          return { ok: true, text, modelUsed: `OpenRouter (${shortName})` };
        }
      }

      lastError = { status, message: data.error?.message || `HTTP ${status}` };

      if (status === 404 || status === 410 || status === 422 || status === 429 || status === 500 || status === 503) {
        continue;
      }
      if (status === 401 || status === 403) break;
    } catch (e) {
      lastError = { status: 0, message: e.message };
    }
  }

  return { ok: false, status: lastError?.status || 500, error: lastError?.message || 'All OpenRouter free models failed' };
}

// ─── 4. NVIDIA NIM Provider ───────────────────────────────────────────────────

async function discoverNvidiaModels(apiKey) {
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      const models = (data.data || []).map((m) => m.id);
      if (models.length > 0) return models;
    }
  } catch (e) {}
  return null;
}

async function getNvidiaCandidateModels(apiKey) {
  const priorityList = [
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-70b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'deepseek-ai/deepseek-r1',
    'mistralai/mistral-large-2-instruct',
    'qwen/qwen2.5-72b-instruct',
    'meta/llama-3.1-8b-instruct'
  ];

  try {
    const discovered = await discoverNvidiaModels(apiKey);
    if (discovered && discovered.length > 0) {
      // Strictly exclude diffusion, audio, vision, embed, rerank, guard, reward, or non-text models
      const eligible = discovered.filter((m) => {
        const lower = m.toLowerCase();
        if (/diffusion|audio|vision|embed|rerank|guard|safety|reward|moderation/i.test(lower)) {
          return false;
        }
        return /instruct|chat|nemotron|deepseek|qwen|large/i.test(lower);
      });

      const sorted = [];
      for (const p of priorityList) {
        if (eligible.includes(p)) sorted.push(p);
      }
      for (const m of eligible) {
        if (!sorted.includes(m)) sorted.push(m);
      }
      if (sorted.length > 0) return sorted;
    }
  } catch (e) {}

  return priorityList;
}

async function callNvidia(apiKey, prompt) {
  const candidateModels = await getNvidiaCandidateModels(apiKey);
  let lastError = null;

  for (const model of candidateModels) {
    try {
      const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
      const bodyPayload = {
        model,
        messages: [
          { role: 'system', content: 'You are an expert academic quiz solver. Output ONLY a valid JSON object matching the requested schema without Markdown formatting.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 1024
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify(bodyPayload)
      });

      const status = response.status;
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const text = data.choices?.[0]?.message?.content;
        if (text) {
          const shortName = model.split('/')[1] || model;
          return { ok: true, text, modelUsed: `NVIDIA (${shortName})` };
        }
      }

      lastError = { status, message: data.error?.message || `HTTP ${status}` };

      if (status === 410 || status === 404 || status === 422 || status === 429 || status === 500 || status === 503) {
        continue;
      }
      if (status === 401 || status === 403) break;
    } catch (e) {
      lastError = { status: 0, message: e.message };
    }
  }

  return { ok: false, status: lastError?.status || 500, error: lastError?.message || 'All NVIDIA models failed' };
}

// ─── Cooldown & Activity Logging Utilities ───────────────────────────────────

async function appendLog(message, type = 'info') {
  try {
    const time = new Date().toLocaleTimeString();
    const data = await chrome.storage.local.get(['activityLogs']);
    const logs = data.activityLogs || [];
    logs.unshift({ time, message, type });
    if (logs.length > 80) logs.pop();
    await chrome.storage.local.set({ activityLogs: logs });
  } catch (e) {
    console.warn('[AutoPilot BG] Could not append log:', e);
  }
}

async function getCooldowns() {
  const data = await chrome.storage.local.get(['providerCooldowns']);
  return data.providerCooldowns || {};
}

async function setCooldown(providerId, ms = 25000) {
  const cooldowns = await getCooldowns();
  cooldowns[providerId] = Date.now() + ms;
  await chrome.storage.local.set({ providerCooldowns: cooldowns });
}

async function clearCooldown(providerId) {
  const cooldowns = await getCooldowns();
  if (cooldowns[providerId]) {
    delete cooldowns[providerId];
    await chrome.storage.local.set({ providerCooldowns: cooldowns });
  }
}

// ─── Multi-Provider Dispatcher ────────────────────────────────────────────────

const activeAIRequests = new Map();

async function executeAIRequest(request) {
  const prompt = request.prompt;
  if (!prompt) return { success: false, error: 'No prompt provided to AI dispatcher.' };

  const storage = await chrome.storage.local.get([
    'geminiApiKey',
    'groqApiKey',
    'openRouterApiKey',
    'nvidiaApiKey',
    'preferredProvider',
    'providerCooldowns'
  ]);

  const keys = {
    groq: (storage.groqApiKey || '').trim(),
    gemini: (storage.geminiApiKey || '').trim(),
    openrouter: (storage.openRouterApiKey || '').trim(),
    nvidia: (storage.nvidiaApiKey || '').trim()
  };

  const cooldowns = storage.providerCooldowns || {};

  const defaultOrder = ['groq', 'gemini', 'openrouter', 'nvidia'];
  const pref = storage.preferredProvider;
  const candidateOrder = pref && pref !== 'auto' && defaultOrder.includes(pref)
    ? [pref, ...defaultOrder.filter((p) => p !== pref)]
    : defaultOrder;

  const availableProviders = candidateOrder.filter((pId) => !!keys[pId]);

  if (availableProviders.length === 0) {
    const errMsg = 'No AI API keys configured. Please add a free key (Groq, Gemini, OpenRouter, or NVIDIA) in the popup.';
    await appendLog(errMsg, 'error');
    return {
      success: false,
      error: errMsg
    };
  }

  // Check cooldown status
  const now = Date.now();
  const readyProviders = availableProviders.filter((pId) => {
    const cd = cooldowns[pId] || 0;
    return now >= cd;
  });

  let providersToTry = readyProviders;

  if (readyProviders.length === 0) {
    let earliestPId = availableProviders[0];
    let minCd = cooldowns[earliestPId] || 0;
    for (const pId of availableProviders) {
      const cd = cooldowns[pId] || 0;
      if (cd < minCd) {
        minCd = cd;
        earliestPId = pId;
      }
    }
    const waitSec = Math.max(1, Math.ceil((minCd - now) / 1000));
    if (waitSec <= 5) {
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      providersToTry = [earliestPId];
    } else {
      const errMsg = `All AI providers in cooldown. Next provider ready in ${waitSec}s.`;
      await appendLog(`⏳ ${errMsg}`, 'warn');
      return { success: false, error: errMsg };
    }
  }

  const failureLogs = [];

  for (const pId of providersToTry) {
    const prov = PROVIDERS[pId];
    const key = keys[pId];

    await appendLog(`Querying AI engine: ${prov.name}...`, 'info');

    try {
      const result = await prov.call(key, prompt);
      if (result.ok && result.text) {
        await clearCooldown(pId);
        const modelLabel = result.modelUsed || prov.name;
        await appendLog(`✓ Answer received from ${modelLabel}`, 'success');
        return {
          success: true,
          text: result.text,
          provider: modelLabel,
          providerId: pId
        };
      }

      const status = result.status || 500;
      const errMsg = result.error || `HTTP ${status}`;
      failureLogs.push(`${prov.name}: ${errMsg}`);

      if (status === 429 || status === 503) {
        await setCooldown(pId, 25000);
        await appendLog(`⚠️ ${prov.name} rate-limited (HTTP ${status}). Cooling down 25s...`, 'warn');
      } else if (status === 401 || status === 403) {
        await setCooldown(pId, 120000);
        await appendLog(`⚠️ ${prov.name} authentication failed (verify key). Cooling down 2m...`, 'warn');
      } else {
        await setCooldown(pId, 20000);
        await appendLog(`⚠️ ${prov.name} returned error: ${errMsg}. Trying next provider...`, 'warn');
      }
    } catch (e) {
      await setCooldown(pId, 20000);
      failureLogs.push(`${prov.name}: ${e.message}`);
      await appendLog(`⚠️ ${prov.name} exception: ${e.message}. Trying next provider...`, 'warn');
    }
  }

  const finalErr = `All available AI providers failed:\n${failureLogs.join('\n')}`;
  await appendLog(finalErr, 'error');
  return {
    success: false,
    error: finalErr
  };
}

async function handleAIRequest(request) {
  // Only identical prompts may share a response. Different tabs can ask different questions.
  const key = request.prompt;
  if (activeAIRequests.has(key)) return activeAIRequests.get(key);
  const pending = executeAIRequest(request);
  activeAIRequests.set(key, pending);
  try {
    return await pending;
  } finally {
    activeAIRequests.delete(key);
  }
}

// ─── Badge Management ─────────────────────────────────────────────────────────

function updateBadge(text, color = '#0a66c2') {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {}
}

// ─── Extension Message Dispatcher ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ASK_AI' || message.type === 'ASK_AI' || message.action === 'ASK_GEMINI' || message.type === 'ASK_GEMINI') {
    handleAIRequest(message).then(sendResponse);
    return true;
  }

  if (message.action === 'RESET_COOLDOWNS' || message.type === 'RESET_COOLDOWNS') {
    chrome.storage.local.set({ providerCooldowns: {} }, () => {
      appendLog('Provider cooldowns manually reset.', 'info');
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'APPEND_LOG' || message.type === 'APPEND_LOG') {
    appendLog(message.message, message.logType || message.type || 'info').then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'TEST_AI_KEY') {
    const { provider, apiKey } = message;
    const testPrompt = 'Respond ONLY with JSON: {"status": "ok", "message": "connection verified"}';
    const prov = PROVIDERS[provider];
    if (!prov) {
      sendResponse({ success: false, error: 'Unknown provider.' });
      return true;
    }
    prov.call(apiKey, testPrompt)
      .then((res) => {
        if (res.ok) {
          sendResponse({ success: true, modelUsed: res.modelUsed });
        } else {
          sendResponse({ success: false, error: res.error || 'Connection failed' });
        }
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getStorage') {
    chrome.storage.local.get([
      'speed',
      'autoplay',
      'backgroundRun',
      'skipNonVideos',
      'autoSolveQuizzes',
      'geminiApiKey',
      'groqApiKey',
      'openRouterApiKey',
      'nvidiaApiKey',
      'preferredProvider'
    ], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (message.action === 'setStorage') {
    chrome.storage.local.set(message.data, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'updateBadge') {
    updateBadge(message.text, message.color || '#0a66c2');
    sendResponse({ ok: true });
    return true;
  }
});

// ─── Keepalive Port Connection ────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'li-learn-keepalive') {
    port.onMessage.addListener((msg) => {
      if (msg.action === 'ping') {
        port.postMessage({ action: 'pong' });
      }
    });
  }
});


function sendBackgroundPulseWithTimeout(api, id, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Background tab response timed out')), timeoutMs);
    Promise.resolve().then(() => api.tabs.sendMessage(id, {action:'backgroundPulse'}))
      .then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function installBackgroundSupervisor(api) {
  if (!api.alarms || !api.storage.session || !api.tabs?.onUpdated) return;
  const key = 'learningBackgroundTabs', alarm = 'learning-background-pulse';
  let serial = Promise.resolve();
  const enqueue = task => {
    const next = serial.then(task);
    serial = next.catch(() => {});
    return next;
  };
  const isLearning = raw => {
    try { const url = new URL(raw); return url.origin === 'https://www.linkedin.com' &&
      /^\/(?:learning|learning-career-hub|career-hub)\//.test(url.pathname); } catch (_) { return false; }
  };
  const read = async () => (await api.storage.session.get(key))[key] || {};
  const save = async rows => {
    await api.storage.session.set({[key]:rows});
    if (Object.keys(rows).length) {
      const existing = api.alarms.get ? await api.alarms.get(alarm) : null;
      if (!existing) await api.alarms.create(alarm, {periodInMinutes:0.5});
    } else await api.alarms.clear(alarm);
  };
  const release = async (rows, id) => {
    const row = rows[id];
    if (!row) return;
    delete rows[id];
    try { await api.tabs.update(Number(id), {autoDiscardable:row.originalAutoDiscardable}); } catch (_) {}
  };
  const pulse = async onlyId => {
    const rows = await read();
    for (const id of Object.keys(rows)) {
      if (onlyId !== undefined && Number(id) !== onlyId) continue;
      try {
        const tab = await api.tabs.get(Number(id));
        if (!isLearning(tab.url)) { await release(rows, id); continue; }
        const response = await sendBackgroundPulseWithTimeout(api, Number(id));
        if (response?.active === false) await release(rows, id);
        else if (response?.active === true) rows[id].lastSeen = Date.now();
      } catch (_) {
        // Allow page loads to reconnect, then expire abandoned registrations.
        if (Date.now() - rows[id].lastSeen > 120000) await release(rows, id);
      }
    }
    await save(rows);
  };
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.action !== 'backgroundRunState' || !sender.tab || (sender.frameId || 0) !== 0) return;
    enqueue(async () => {
      const rows = await read(), id = sender.tab.id;
      const tab = await api.tabs.get(id);
      if (message.enabled && isLearning(tab.url)) {
        if (!rows[id]) rows[id] = {originalAutoDiscardable:tab.autoDiscardable !== false};
        rows[id].lastSeen = Date.now();
        await api.storage.session.set({[key]:rows});
        await api.tabs.update(id, {autoDiscardable:false});
      } else await release(rows, id);
      await save(rows);
      return {success:true};
    }).then(respond, () => respond({success:false}));
    return true;
  });
  api.alarms.onAlarm.addListener(event => {
    if (event.name === alarm) enqueue(() => pulse());
  });
  api.tabs.onUpdated.addListener((id, changes) => {
    if (changes.url && !isLearning(changes.url)) enqueue(async () => {
      const rows = await read(); await release(rows, id); await save(rows);
    });
    else if (changes.status === 'complete') enqueue(() => pulse(id));
  });
  api.tabs.onRemoved.addListener(id => enqueue(async () => {
    const rows = await read(); delete rows[id]; await save(rows);
  }));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bgPlay?.newValue === false) enqueue(async () => {
      const rows = await read();
      for (const id of Object.keys(rows)) await release(rows, id);
      await save(rows);
    });
  });
  // Session storage survives service-worker suspension; recreate lost alarms.
  enqueue(async () => { const rows = await read(); await save(rows); });
}

installBackgroundSupervisor(chrome);
