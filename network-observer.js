/* Passive observation only: no API requests, credentials or quiz answers are replayed. */
(function () {
  function createLearningObserver(env) {
    const identities = new Map();
    const maxBytes = 1024 * 1024;
    function classify(raw, method, path, startedAt) {
      try {
        const url = new URL(raw, env.location.href);
        if (url.origin !== 'https://www.linkedin.com') return null;
        let kind = null;
        const operation = (url.searchParams.get('queryId') || '').split('.')[0];
        if (url.pathname === '/learning-api/graphql') {
          if (method === 'GET' && operation === 'videos') kind = 'videoIdentity';
          if (method === 'GET' && operation === 'assessments') kind = 'quizIdentity';
          if (method === 'POST' && operation === 'clientReportedContentStateChangeActions') kind = 'video';
        }
        if (url.pathname === '/learning-api/detailedAssessmentStatuses' && method === 'POST') kind = 'quiz';
        if (!kind) return null;
        return {kind, path, startedAt, action:url.searchParams.get('action'), variables:url.searchParams.get('variables') || ''};
      } catch (_) { return null; }
    }
    const remember = (urn, path) => {
      if (!urn || !path || env.location.pathname !== path) return;
      identities.delete(urn); identities.set(urn, path);
      while (identities.size > 50) identities.delete(identities.keys().next().value);
    };
    function observe(meta, request, response, status) {
      if (!meta) return;
      if (meta.kind === 'videoIdentity' || meta.kind === 'quizIdentity') {
        if (status < 200 || status >= 300 || response?.errors?.length) return;
        for (const item of response?.included || []) {
          if (meta.kind === 'videoIdentity' && /\.Video$/.test(item.$type || '') &&
              typeof item.slug === 'string' && decodeURIComponent(meta.path.split('/').pop()) === item.slug) remember(item.entityUrn, meta.path);
          if (meta.kind === 'quizIdentity' && /\.Assessment$/.test(item.$type || '') &&
              typeof item.entityUrn === 'string' && meta.variables.includes(item.entityUrn)) remember(item.entityUrn, meta.path);
        }
        return;
      }
      const state = request?.variables?.clientReportedStateChangeData;
      const urn = meta.kind === 'quiz' ? request?.assessmentUrn : state?.contentUrn;
      const path = identities.get(urn);
      // Route-at-request time alone is insufficient: a prior video can report late.
      if (!path || path !== meta.path) return;
      const emit = statusName => env.emit({type:'LI_NETWORK_STATUS',kind:meta.kind,status:statusName,
        path,startedAt:meta.startedAt,observedAt:env.now()});
      if (status < 200 || status >= 300 || response?.errors?.length || response?.data?.errors?.length) { emit('FAILED'); return; }
      if (meta.kind === 'video') {
        const result = response?.data?.data?.doReportContentStateChangeClientReportedContentStateChangeActions?.result;
        if (result?.__typename !== 'restli_common_EmptyRecord') return;
        if (['COMPLETED','IN_PROGRESS','NOT_STARTED'].includes(state?.currentClientProgressState)) emit(state.currentClientProgressState);
      } else {
        // Only the submitted assessment's basic status, not an unrelated nested record.
        const rows = (response?.included || []).filter(item => /\.ConsistentBasicAssessmentStatus$/.test(item.$type || ''));
        if (rows.length !== 1) return; // Ambiguous response: defer to the page's completion status.
        const row = rows[0];
        const detail = row?.details;
        if (detail?.statusType === 'COMPLETED' && Number.isFinite(detail.completedAt)) emit('COMPLETED');
        else if (meta.action === 'reset' || detail?.statusType === 'IN_PROGRESS') emit('IN_PROGRESS');
      }
    }
    async function parseText(text) {
      if (typeof text !== 'string' || text.length > maxBytes) return null;
      try { return JSON.parse(text); } catch (_) { return null; }
    }
    function install() {
      const nativeFetch = env.window.fetch;
      if (typeof nativeFetch === 'function') env.window.fetch = function (input, init) {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        const meta = classify(raw, (init?.method || input?.method || 'GET').toUpperCase(), env.location.pathname, env.now());
        // Clone only observed requests; never inspect headers or consume the app's body.
        let body = Promise.resolve(null);
        if (meta && meta.kind !== 'videoIdentity' && meta.kind !== 'quizIdentity') {
          try { body = typeof init?.body === 'string' ? parseText(init.body) :
            input?.clone ? input.clone().text().then(parseText).catch(() => null) : body; } catch (_) {}
        }
        const result = nativeFetch.apply(this, arguments);
        if (meta) Promise.resolve(result).then(async response => {
          try {
            const data = await parseText(await response.clone().text());
            observe(meta, await body, data, response.status);
          } catch (_) {}
        }, () => {});
        return result;
      };
      const proto = env.window.XMLHttpRequest?.prototype;
      if (proto) {
        const open = proto.open, send = proto.send, records = new WeakMap();
        proto.open = function (method, raw) {
          records.set(this, {raw,method:String(method).toUpperCase()});
          return open.apply(this, arguments);
        };
        proto.send = function (body) {
          const record = records.get(this);
          const meta = record && classify(record.raw, record.method, env.location.pathname, env.now());
          if (meta) this.addEventListener('load', async () => {
            try {
              const response = this.responseType === 'json' ? this.response :
                (!this.responseType || this.responseType === 'text') ? await parseText(this.responseText) : null;
              observe(meta, await parseText(body), response, this.status);
            } catch (_) {}
          }, {once:true});
          return send.apply(this, arguments);
        };
      }
    }
    return {classify,observe,install};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {createLearningObserver};
  if (typeof window !== 'undefined' && !window.__liNetworkObserverInstalled) {
    window.__liNetworkObserverInstalled = true;
    createLearningObserver({window,location:window.location,now:()=>Date.now(),
      emit:message=>window.postMessage(message,window.location.origin)}).install();
  }
})();
