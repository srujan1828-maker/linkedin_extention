const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const noop = () => {};

function speedEngine() {
  class Media {
    constructor() { this.rate = 1; this.readyState = 4; this.paused = true; this.muted = false; this.preservesPitch = true; }
    get playbackRate() { return this.rate; }
    set playbackRate(value) { this.rate = value; }
    addEventListener() {}
    play() { throw Error('Speed changes must not start playback'); }
  }
  const video = new Media();
  const listeners = {}, documentListeners = {}, timers = [], posts = [];
  let nativeHidden = true, nativeFocus = true;
  const document = Object.create({ get hidden() { return nativeHidden; }, get visibilityState() { return nativeHidden ? 'hidden' : 'visible'; } });
  Object.assign(document, { querySelector: () => video, querySelectorAll: () => [video], hasFocus: () => nativeFocus, addEventListener: (type, fn) => (documentListeners[type] ||= []).push(fn) });
  const window = { location:{origin:'https://www.linkedin.com',pathname:'/learning/example/lesson'}, postMessage: m => posts.push(m), addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) };
  vm.runInNewContext(source('page-inject.js'), { window, document, HTMLMediaElement: Media, console, setInterval: noop, setTimeout: fn => timers.push(fn) });
  const message = data => listeners.message.forEach(fn => fn({ source: window, data }));
  return { video, document, window, message, listeners, documentListeners, timers, posts,
    setHidden: value => { nativeHidden = value; }, setFocus: value => { nativeFocus = value; },
    emitWindow: type => (listeners[type] || []).forEach(fn => fn({type, target:window, stopImmediatePropagation:noop})),
    emitDocument: (type, event = {}) => (documentListeners[type] || []).forEach(fn => fn({type, target:video, ...event})) }; 
}

test('engine starts inactive and preserves sound and pause preferences at high rates', () => {
  const e = speedEngine();
  assert.equal(e.video.playbackRate, 1);
  assert.equal(e.window.__liSpeedEngine.isEnabled(), false);
  e.message({ type: 'LI_FORCE_SPEED', speed: 16, enabled: true });
  assert.equal(e.video.playbackRate, 16);
  assert.equal(e.window.__liSpeedEngine.getNativePlaybackRate(), 16);
  assert.equal(e.video.muted, false);
  assert.equal(e.video.preservesPitch, true);
  assert.equal(e.video.paused, true);
});

test('fractional speeds work; disabling leaves native speed controls usable', () => {
  const e = speedEngine();
  e.message({ type: 'LI_FORCE_SPEED', speed: 0.5, enabled: true });
  assert.equal(e.video.playbackRate, 0.5);
  e.video.playbackRate = 2;
  assert.equal(e.video.playbackRate, 0.5);
  e.message({ type: 'LI_FORCE_SPEED', speed: 16, enabled: false });
  assert.equal(e.video.playbackRate, 1);
  e.video.playbackRate = 1.5;
  assert.equal(e.video.playbackRate, 1.5);
});

test('background play follows the toggle and rejects messages from other windows', () => {
  const e = speedEngine();
  assert.equal(e.document.hidden, true);
  e.listeners.message[0]({ source: {}, data: { type: 'LI_SET_BACKGROUND_PLAY', enabled: true } });
  assert.equal(e.document.hidden, true);
  e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: true });
  assert.equal(e.document.hidden, false);
  e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: false });
  assert.equal(e.document.visibilityState, 'hidden');
});

async function content(saved, initialUrl = 'https://www.linkedin.com/learning/example/lesson') {
  const messages = [], runtime = [], storage = [], timers = [], intervals = [], mutations = [];
  let attached = 0;
  const document = { body: { innerText: '', querySelector: () => null, querySelectorAll: () => [] }, hidden: false, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop };
  const parsedUrl = new URL(initialUrl);
  const window = { location: { href: initialUrl, pathname: parsedUrl.pathname, origin: parsedUrl.origin }, addEventListener: noop, postMessage: m => messages.push(m) };
  const chrome = {
    runtime: { id: 'test', connect: () => ({ onDisconnect: { addListener: noop }, postMessage: noop }), onMessage: { addListener: fn => runtime.push(fn) }, sendMessage: noop },
    storage: { local: { get: async () => saved, set: async data => Object.assign(saved, data) }, onChanged: { addListener: fn => storage.push(fn) } }
  };
  const ctx = vm.createContext({ window, document, chrome, console, AbortController, URL, URLSearchParams, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: noop, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: noop, MutationObserver: class { constructor(fn) { attached++; mutations.push(fn); } observe() {} } });
  vm.runInContext(source('content.js'), ctx);
  assert.equal(attached, 0, 'player observation must wait for saved settings');
  await new Promise(resolve => setImmediate(resolve));
  return { ctx, document, window, chrome, saved, messages, runtime, storage, timers, intervals, mutations, attached };
}

test('saved disabled preferences load before player observation and propagate live', async () => {
  const c = await content({ speedInjection: false, playbackSpeed: 0.75, bgPlay: false, autoNavigate: false });
  assert.equal(c.attached, 1);
  assert.equal(vm.runInContext('speedInjectionEnabled', c.ctx), false);
  assert.equal(vm.runInContext('backgroundRun', c.ctx), false);
  assert.equal(vm.runInContext('autoNavigateEnabled', c.ctx), false);
  c.runtime[0]({ action: 'setBgPlay', enabled: true }, {}, noop);
  assert.equal(c.messages.at(-1).enabled, true);
  c.runtime[0]({ action: 'setSpeedInjection', enabled: false }, {}, noop);
  assert.equal(c.messages.at(-2).enabled, false);
  c.storage[0]({ playbackSpeed: { newValue: 3 }, speedInjection: { newValue: true } }, 'local');
  assert.equal(c.messages.at(-2).speed, 3);
  assert.equal(c.messages.at(-2).enabled, true);
});

test('speed changes do not resume paused media or alter mute preferences', async () => {
  const c = await content({ playbackSpeed: 2 });
  const video = { muted: true, paused: true, playbackRate: 1, play: () => { throw Error('Unexpected play'); } };
  c.ctx.fixture = video;
  vm.runInContext('applySpeed(fixture, 4)', c.ctx);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 4);
});

test('stop prevents delayed bulk lesson navigation', async () => {
  const c = await content({ bulkActive: false });
  vm.runInContext('isBulkActive = true', c.ctx);
  const pending = vm.runInContext("handleVideoEnded('/learning/example/lesson', 0)", c.ctx);
  c.runtime[0]({ action: 'stopBulkComplete' }, {}, noop);
  let navigations = 0;
  c.ctx.trackNavigation = () => navigations++;
  vm.runInContext('expandAllSections = trackNavigation', c.ctx);
  c.timers.at(-1)();
  await pending;
  assert.equal(navigations, 0);
});

test('AI requests deduplicate identical prompts without sharing unrelated answers', async () => {
  const ctx = vm.createContext({ chrome: { runtime: { onMessage: { addListener: noop }, onConnect: { addListener: noop } } }, console });
  vm.runInContext(source('background.js'), ctx);
  const calls = [];
  ctx.request = req => new Promise(resolve => calls.push({ req, resolve }));
  vm.runInContext('executeAIRequest = request', ctx);
  const a = vm.runInContext("handleAIRequest({ prompt: 'A' })", ctx);
  const b = vm.runInContext("handleAIRequest({ prompt: 'B' })", ctx);
  const a2 = vm.runInContext("handleAIRequest({ prompt: 'A' })", ctx);
  assert.equal(calls.length, 2);
  calls[0].resolve({ text: 'answer A' });
  calls[1].resolve({ text: 'answer B' });
  assert.equal((await a).text, 'answer A');
  assert.equal((await b).text, 'answer B');
  assert.equal((await a2).text, 'answer A');
  assert.equal(vm.runInContext('activeAIRequests.size', ctx), 0);
});


test('answer mapping rejects missing, partial, out-of-range and conflicting answers', async () => {
  const c = await content({});
  c.ctx.options = [{ text: 'Increase focus' }, { text: 'Increase focus gradually' }, { text: 'Take breaks' }];
  for (const answer of [{}, { answerTexts: ['Increase'] }, { answerIndices: [7] },
    { answerIndices: [1], answerTexts: ['Take breaks'] }, { error: true, answerIndices: [0] }]) {
    c.ctx.answer = answer;
    assert.equal(vm.runInContext('matchAnswerIndices(options, answer).length', c.ctx), 0);
  }
  c.ctx.answer = { answerIndices: [2], answerTexts: ['Take breaks'] };
  assert.equal(vm.runInContext('resolveSingleChoiceOption(options, answer).index', c.ctx), 2);
  c.ctx.answer = { answerIndices: [0, 2], answerTexts: ['Increase focus', 'Take breaks'] };
  assert.equal(vm.runInContext('resolveAnswerIndices({type:"checkbox", options}, answer).length', c.ctx), 2);
  assert.equal(vm.runInContext('resolveSingleChoiceOption(options, answer).index', c.ctx), -1);
});

test('AI provider failures and malformed responses never fall back to option zero', async () => {
  const c = await content({});
  c.ctx.q = { prompt: 'Which action helps focus?', type: 'radio', options: [{ text: 'A' }, { text: 'B' }] };
  for (const response of [{ success: false, error: 'Invalid key' }, { success: true, text: 'Maybe A' },
    { success: true, text: '{"answerIndices":[99]}' }]) {
    c.chrome.runtime.sendMessage = (_req, cb) => cb(response);
    await assert.rejects(vm.runInContext('askAIForQuestion(q)', c.ctx));
  }
});

test('checkbox selection clicks once and does not toggle an already selected answer', async () => {
  const c = await content({});
  c.ctx.setTimeout = fn => setImmediate(fn);
  let clicks = 0;
  const input = { checked: false, tagName: 'INPUT', closest: () => null, click() { clicks++; this.checked = !this.checked; } };
  c.ctx.option = { input };
  assert.equal(await vm.runInContext('selectOption(option, true)', c.ctx), true);
  assert.equal(await vm.runInContext('selectOption(option, true)', c.ctx), true);
  assert.equal(clicks, 1);
  assert.equal(await vm.runInContext('selectOption(option, false)', c.ctx), true);
  assert.equal(input.checked, false);
  assert.equal(clicks, 2);
});

test('current chapter quiz parser ignores unrelated page inputs', async () => {
  const c = await content({});
  const cards = ['First option', 'Second option'].map(text => ({ querySelector(selector) {
    if (selector.startsWith('input')) return { type: 'radio' };
    if (selector === '.exam-option__label-text') return { innerText: text };
    return {};
  } }));
  const group = { getClientRects: () => [1], querySelector: () => ({ innerText: 'What is the next step?' }),
    querySelectorAll: () => cards, closest: () => ({ innerText: 'Question 2 of 4' }) };
  c.document.querySelectorAll = selector => selector === '.chapter-quiz-question' ? [group] : [];
  const q = vm.runInContext('parseCurrentQuizQuestion()', c.ctx);
  assert.equal(q.prompt, 'What is the next step?');
  assert.equal(q.counter, 'Question 2 of 4');
  assert.equal(q.type, 'radio');
  assert.deepEqual(Array.from(q.options, o => o.text), ['First option', 'Second option']);
  c.document.querySelectorAll = () => [group, group];
  assert.equal(vm.runInContext('parseCurrentQuizQuestion()', c.ctx), null);
});

test('empty native Viewed marker counts as completed', async () => {
  const c = await content({});
  const row = { closest: () => null, querySelectorAll: () => [],
    querySelector: () => ({ hasAttribute: attr => attr === 'data-live-test-classroom-toc-item-completed', getAttribute: () => '' }) };
  c.ctx.row = row;
  assert.equal(vm.runInContext('isLessonCompleted(row)', c.ctx), true);
});

test('path discovery reads whole cards, deduplicates titles and retains standalone context', async () => {
  const c = await content({});
  const link = (href, text) => ({ getAttribute: () => href, textContent: text });
  const card = (href, text, completed) => ({ completed, querySelector: selector => selector.startsWith('h3') ? link(href, text) : { innerText: 'Video' } });
  const first = card('/learning/course/video?standalone=true&contextUrn=path&u=123', 'Standalone lesson', true);
  const second = card('/learning/another-course?contextUrn=path&u=123', 'Second course', false);
  second.querySelector = selector => selector.startsWith('h3') ? link('/learning/another-course?contextUrn=path&u=123', 'Second course') : { innerText: 'Course' };
  c.document.querySelectorAll = () => [first, first, second];
  vm.runInContext('isPathItemCompleted = card => card.completed', c.ctx);
  const items = vm.runInContext('getLearningPathItems()', c.ctx);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'video');
  assert.equal(items[0].completed, true);
  assert.equal(new URL(items[0].fullHref).searchParams.get('contextUrn'), 'path');
  assert.equal(items[1].type, 'course');
  assert.equal(items[1].completed, false);
});

test('course links retain learning path and organization context', async () => {
  const c = await content({});
  c.window.location.href = 'https://www.linkedin.com/learning/example/current?contextUrn=path&u=123';
  const url = new URL(vm.runInContext('preserveLearningContext("/learning/example/next?resume=false")', c.ctx));
  assert.equal(url.searchParams.get('contextUrn'), 'path');
  assert.equal(url.searchParams.get('u'), '123');
  assert.equal(url.searchParams.get('resume'), 'false');
});

test('path queue persists progress and advances only from its current path', async () => {
  const paths = ['one', 'two'].map(name => ({ title: name, url: 'https://www.linkedin.com/learning/paths/' + name, completed: false }));
  const c = await content({ pathQueueActive: true, pathQueue: paths, pathQueueIndex: 0 });
  vm.runInContext('isBulkActive = true', c.ctx);
  assert.equal(await vm.runInContext('advancePathQueue()', c.ctx), false);
  c.window.location.pathname = '/learning/paths/one';
  assert.equal(await vm.runInContext('advancePathQueue()', c.ctx), true);
  assert.equal(c.saved.pathQueueIndex, 1);
  assert.equal(paths[0].completed, true);
  assert.equal(c.window.location.href, paths[1].url);
  c.window.location.pathname = '/learning/paths/two';
  assert.equal(await vm.runInContext('advancePathQueue()', c.ctx), false);
  assert.equal(c.saved.pathQueueActive, false);
  assert.equal(paths[1].completed, true);
});

test('quiz verification requires the current quiz and rejects generic results headings', async () => {
  const c = await content({});
  c.ctx.setTimeout = fn => setImmediate(fn);
  c.ctx.fixture = [{ href: '/learning/example/quiz/old', completed: true }];
  vm.runInContext('getCourseSyllabus = () => fixture; expandAllSections = () => {}', c.ctx);
  c.window.location.pathname = '/learning/example/quiz/current';
  c.document.querySelector = selector => selector.includes('.chapter-quiz') ? { innerText: 'Results. Keep practicing.', querySelectorAll: () => [] } : null;
  assert.equal(await vm.runInContext('verifyQuizGreenTick(5)', c.ctx), false);
  c.ctx.fixture.push({ href: c.window.location.pathname, completed: true });
  assert.equal(await vm.runInContext('verifyQuizGreenTick(5)', c.ctx), true);
});

test('library discovery expands pagination and queues only unique path headings', async () => {
  const c = await content({}, 'https://www.linkedin.com/learning/me/my-library/in-progress');
  c.ctx.setTimeout = fn => setImmediate(fn);
  vm.runInContext('isElementClickable = () => true', c.ctx);
  let expanded = false;
  const link = name => ({ textContent: name, getAttribute: () => '/learning/paths/' + name + '?u=123' });
  const one = link('one'), two = link('two');
  const more = { getAttribute: () => 'Show more in progress content', click: () => { expanded = true; } };
  c.document.querySelectorAll = selector => {
    if (selector === 'main button') return expanded ? [] : [more];
    if (selector === 'main h3 a') return expanded ? [one, one, two] : [one];
    if (selector === 'main h3 a[href*="/learning/paths/"]') return expanded ? [one, one, two] : [one];
    return [];
  };
  const result = await vm.runInContext('startAllPaths()', c.ctx);
  assert.equal(expanded, true);
  assert.equal(result.totalPaths, 2);
  assert.equal(c.saved.pathQueueActive, true);
  assert.equal(c.saved.bulkActive, true);
  assert.equal(c.saved.focusMode, 'pending_only');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.window.location.href, 'https://www.linkedin.com/learning/paths/one?u=123');
});

test('path completion requires explicit status, not a green progress bar or 100%', async () => {
  const c = await content({});
  c.ctx.card = { innerText: 'Course\nTitle\n100%\nCompleted 10/2/2026' };
  assert.equal(vm.runInContext('isPathItemCompleted(card)', c.ctx), true);
  c.ctx.card.innerText = 'Course\nCompleted Projects\n100%';
  assert.equal(vm.runInContext('isPathItemCompleted(card)', c.ctx), false);
});

test('ordinary autoplay returns to the saved path without bulk mode', async () => {
  const url = 'https://www.linkedin.com/learning/paths/original?u=123';
  const c = await content({ lastLearningPathUrl: url, bulkActive: false });
  assert.equal(await vm.runInContext('returnToLearningPath()', c.ctx), false);
  assert.equal(await vm.runInContext('returnToLearningPath({allowAutoplay:true})', c.ctx), true);
  assert.equal(c.window.location.href, url);
  assert.equal(vm.runInContext('isBulkActive', c.ctx), false);
});

test('a hidden explicit back link supplies the path destination', async () => {
  const c = await content({});
  const href = '/learning/paths/hidden-path?u=123';
  const back = { innerText: 'BACK TO LEARNING PATH', getAttribute: name => name === 'href' ? href : '', closest: () => null };
  c.document.querySelectorAll = selector => selector === 'a[href]' ? [back] : [];
  vm.runInContext('isElementClickable = () => false; isBulkActive = true', c.ctx);
  assert.equal(await vm.runInContext('returnToLearningPath()', c.ctx), true);
  assert.equal(c.window.location.href, 'https://www.linkedin.com' + href);
});

test('return prefers the active queue and skips invalid saved destinations', async () => {
  const queued = 'https://www.linkedin.com/learning/paths/queued?u=123';
  const c = await content({ lastLearningPathUrl: 'https://example.com/learning/paths/wrong', pathQueueActive: true,
    pathQueueIndex: 1, pathQueue: [{url:'https://www.linkedin.com/learning/paths/old'}, {url:queued}] });
  vm.runInContext('isBulkActive = true', c.ctx);
  assert.equal(await vm.runInContext('returnToLearningPath()', c.ctx), true);
  assert.equal(c.window.location.href, queued);
  const d = await content({ lastLearningPathUrl: 'https://example.com/learning/paths/wrong' });
  d.document.referrer = 'https://www.linkedin.com/learning/paths/referrer?u=123';
  vm.runInContext('isBulkActive = true', d.ctx);
  assert.equal(await vm.runInContext('returnToLearningPath()', d.ctx), true);
  assert.equal(d.window.location.href, d.document.referrer);
});

test('Stop cancels return while storage is being read', async () => {
  const c = await content({});
  vm.runInContext('isBulkActive = true', c.ctx);
  let resolveRead;
  c.chrome.storage.local.get = () => new Promise(resolve => { resolveRead = resolve; });
  const original = c.window.location.href;
  const pending = vm.runInContext('returnToLearningPath()', c.ctx);
  vm.runInContext('quizRunEpoch++; isBulkActive = false', c.ctx);
  resolveRead({ lastLearningPathUrl: 'https://www.linkedin.com/learning/paths/original' });
  assert.equal(await pending, false);
  assert.equal(c.window.location.href, original);
});

test('final exam presence does not block the return to the path', async () => {
  const url = 'https://www.linkedin.com/learning/paths/original';
  const c = await content({ lastLearningPathUrl: url });
  const exam = { closest: () => null };
  c.document.querySelector = selector => selector.includes('/learning/exams/summative/') ? exam : null;
  vm.runInContext('isLessonCompleted = () => false; isBulkActive = true', c.ctx);
  assert.equal(await vm.runInContext('finishCourseAndReturnToPath()', c.ctx), true);
  assert.equal(c.window.location.href, url);
  assert.equal(c.saved.bulkActive, undefined, 'bulk is not stopped on the course page');
  assert.equal(c.saved.pathExamNotice.courseSlug, 'example');
  assert.equal(c.saved.pathExamNotice.pathUrl, url);
});

test('return respects disabled navigation and cancels old lesson fallbacks', async () => {
  const url = 'https://www.linkedin.com/learning/paths/original';
  const c = await content({ lastLearningPathUrl: url, autoNavigate: false });
  vm.runInContext('isBulkActive = true', c.ctx);
  assert.equal(await vm.runInContext('returnToLearningPath()', c.ctx), false);
  let cancelled;
  c.ctx.clearTimeout = id => { cancelled = id; };
  vm.runInContext('autoNavigateEnabled = true; navWatchdogTimer = 42', c.ctx);
  assert.equal(await vm.runInContext('returnToLearningPath()', c.ctx), true);
  assert.equal(cancelled, 42);
  assert.equal(vm.runInContext('navWatchdogTimer', c.ctx), null);
});


test('background toggle restores native focus when disabled and never starts paused media', () => {
  const e = speedEngine();
  e.setFocus(false);
  assert.equal(e.document.hasFocus(), false);
  e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: true });
  assert.equal(e.document.hasFocus(), true);
  assert.equal(e.video.paused, true);
  assert.equal(e.timers.length, 0);
  e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: false });
  assert.equal(e.document.hasFocus(), false);
});

test('tab-switch pause resumes previously playing media outside bulk mode', async () => {
  const e = speedEngine();
  e.setHidden(false);
  e.video.paused = false;
  let plays = 0;
  e.video.play = async () => { plays++; e.video.paused = false; };
  e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: true });
  e.setHidden(true);
  e.emitWindow('visibilitychange');
  e.video.paused = true;
  e.emitDocument('pause');
  assert.equal(e.timers.length, 1);
  await e.timers.shift()();
  assert.equal(plays, 1);
  assert.equal(e.video.paused, false);
});

test('trusted pause input or disabling background play cancels scheduled recovery', async () => {
  for (const cancel of ['input', 'disable']) {
    const e = speedEngine();
    e.setHidden(false);
    e.video.paused = false;
    let plays = 0;
    e.video.play = async () => { plays++; };
    e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: true });
    e.emitWindow('blur');
    if (cancel === 'input') e.emitDocument('keydown', {isTrusted:true,key:' '});
    e.video.paused = true;
    e.emitDocument('pause');
    if (cancel === 'disable') e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: false });
    while (e.timers.length) await e.timers.shift()();
    assert.equal(plays, 0);
  }
});

test('foreground pauses remain paused and recovery is bounded for repeated background pauses', async () => {
  const e = speedEngine();
  e.setHidden(false);
  e.video.paused = false;
  let plays = 0;
  e.video.play = async () => { plays++; e.video.paused = false; };
  e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: true });
  e.video.paused = true;
  e.emitDocument('pause');
  assert.equal(e.timers.length, 0);
  e.video.paused = false;
  e.emitWindow('blur');
  for (let i = 0; i < 3; i++) {
    e.video.paused = true;
    e.emitDocument('pause');
    if (e.timers.length) await e.timers.shift()();
  }
  assert.equal(plays, 2);
});

test('blocked background recovery requests managed fallback without native retry loops', async () => {
  const e = speedEngine();
  e.setHidden(false);
  e.video.paused = false;
  e.message({ type: 'LI_SET_BACKGROUND_PLAY', enabled: true });
  e.emitWindow('blur');
  e.video.paused = true;
  e.video.play = async () => { throw Error('NotAllowedError'); };
  e.emitDocument('pause');
  await e.timers.shift()();
  assert.equal(e.posts.at(-1).type, 'LI_BACKGROUND_PLAY_BLOCKED');
  e.emitDocument('pause');
  assert.equal(e.timers.length, 0);
});

function chapterQuizFixture(c) {
  let submitted = false, clicks = 0, submissions = 0;
  const inputs = ['First answer', 'Second answer'].map(text => ({ type: 'radio', disabled: false, checked: false,
    closest: () => null, click() { inputs.forEach(input => { input.checked = false; }); this.checked = true; clicks++; } }));
  const cards = inputs.map((input, i) => ({ querySelector(selector) {
    if (selector.startsWith('input')) return input;
    if (selector === '.exam-option__label-text') return {innerText:i ? 'Second answer' : 'First answer'};
    return {innerText:i ? 'Second answer' : 'First answer'};
  } }));
  const submit = {innerText:'Submit', disabled:false, getClientRects:()=>[1], closest:()=>null, getAttribute:()=>null,
    click() { assert.equal(inputs[1].checked, true); submitted = true; submissions++; } };
  const root = {get innerText() {return submitted ? 'You passed' : 'Question 1 of 1';},
    querySelector: () => null, querySelectorAll: () => submitted ? [] : [submit]};
  const group = {getClientRects:()=>[1], querySelector:()=>({innerText:'Which is the second answer?'}),
    querySelectorAll:selector=>selector.startsWith('input') ? inputs : cards, closest:()=>root};
  c.window.location.pathname = '/learning/example/quiz/current';
  c.window.location.href = 'https://www.linkedin.com' + c.window.location.pathname;
  c.document.querySelector = selector => selector.startsWith('.chapter-quiz,') ? root : null;
  c.document.querySelectorAll = selector => {
    if (selector === '.chapter-quiz-question') return submitted ? [] : [group];
    if (selector.startsWith('button,')) return submitted ? [] : [submit];
    return [];
  };
  c.document.body = {get innerText(){return root.innerText;}, querySelector:()=>null, querySelectorAll:()=>[]};
  c.ctx.fixtureSyllabus = () => [{href:c.window.location.pathname, title:'Chapter Quiz', completed:submitted}];
  vm.runInContext('getCourseSyllabus = fixtureSyllabus; expandAllSections = () => {}; showHUD = () => {}; sendProgress = () => {}; isElementClickable = () => true', c.ctx);
  return { root, inputs, stats:()=>({clicks,submissions,submitted}) };
}

test('an active chapter question overrides a Viewed completion marker and cached completion', async () => {
  const c = await content({});
  chapterQuizFixture(c);
  vm.runInContext('getCourseSyllabus = () => [{href:window.location.pathname,completed:true}]; solvedQuizUrls.add(window.location.href)', c.ctx);
  let solves = 0;
  c.ctx.fakeSolve = async () => { solves++; return true; };
  vm.runInContext('solveLinkedInQuizWithGreenTickRetry = fakeSolve; checkAndAutoSolveQuiz()', c.ctx);
  await c.timers.at(-1)();
  assert.equal(solves, 1);
  assert.equal(await vm.runInContext('verifyQuizGreenTick(5)', c.ctx), false);
});

test('late chapter quiz mount triggers through the observer', async () => {
  const c = await content({});
  chapterQuizFixture(c);
  let solves = 0;
  c.ctx.fakeSolve = async () => { solves++; return true; };
  vm.runInContext('solveLinkedInQuizWithGreenTickRetry = fakeSolve', c.ctx);
  c.mutations[0]();
  await c.timers.at(-1)();
  assert.equal(solves, 1);
});

test('watchdog waits on a chapter quiz instead of skipping it as non-video content', async () => {
  const c = await content({});
  chapterQuizFixture(c);
  let skips = 0, checks = 0;
  c.ctx.fakeNext = () => { skips++; };
  c.ctx.fakeCheck = () => { checks++; };
  vm.runInContext('goToNextLesson = fakeNext; checkAndAutoSolveQuiz = fakeCheck', c.ctx);
  const timerCount = c.timers.length;
  c.intervals.at(-1)();
  assert.equal(checks, 1);
  assert.equal(skips, 0);
  assert.equal(c.timers.length, timerCount);
});

test('provider correction clears the current quiz error and schedules a retry', async () => {
  const c = await content({});
  chapterQuizFixture(c);
  vm.runInContext('quizError = "Invalid key"; quizErrorUrl = window.location.href; lastQuizCheckTime = 0', c.ctx);
  const before = c.timers.length;
  vm.runInContext('checkAndAutoSolveQuiz()', c.ctx);
  assert.equal(c.timers.length, before);
  c.storage[0]({groqApiKey:{newValue:'test-only-key'}}, 'local');
  assert.equal(vm.runInContext('quizError', c.ctx), null);
  assert.equal(c.timers.length, before + 1);
});

test('Stop pauses quiz automation without permanently disabling its preference', async () => {
  const c = await content({autoSolve:true,autoSolveQuizzes:true});
  c.runtime[0]({action:'stopBulkComplete'}, {}, noop);
  assert.equal(c.saved.autoSolve, true);
  assert.equal(vm.runInContext('autoSolveQuizzes', c.ctx), true);
  assert.equal(vm.runInContext('quizAutoPaused', c.ctx), true);
});

test('chapter quiz workflow selects, submits and verifies with one provider request and no duplicate run', async () => {
  const c = await content({});
  const fixture = chapterQuizFixture(c);
  c.ctx.setTimeout = fn => setImmediate(fn);
  let providerCalls = 0, respond;
  let requestReady;
  const requested = new Promise(resolve => { requestReady = resolve; });
  c.chrome.runtime.sendMessage = (request, cb) => {
    if (request.action === 'ASK_AI') {providerCalls++; respond = cb; requestReady();}
  };
  const run = vm.runInContext('solveLinkedInQuizWithGreenTickRetry(1)', c.ctx);
  await requested;
  assert.equal(await vm.runInContext('solveLinkedInQuizWithGreenTickRetry(1)', c.ctx), false);
  respond({success:true,provider:'Fixture',text:JSON.stringify({answerIndices:[1],answerTexts:['Second answer'],rationale:'Matches the fixture question.'})});
  assert.equal(await run, true);
  assert.deepEqual(fixture.stats(), {clicks:1,submissions:1,submitted:true});
  assert.equal(providerCalls, 1);
  assert.equal(vm.runInContext('isQuizWorkflowRunning', c.ctx), false);
});

test('unverified completion pauses bulk mode after bounded retries', async () => {
  const c = await content({});
  chapterQuizFixture(c);
  c.ctx.setTimeout = fn => setImmediate(fn);
  c.chrome.runtime.sendMessage = (request, cb) => {
    if (request.action === 'ASK_AI') cb({success:true,text:'{"answerIndices":[1],"answerTexts":["Second answer"]}'});
  };
  vm.runInContext('verifyQuizGreenTick = async () => false; isBulkActive = true', c.ctx);
  assert.equal(await vm.runInContext('solveLinkedInQuizWithGreenTickRetry(1)', c.ctx), false);
  assert.equal(c.saved.bulkActive, false);
  assert.match(vm.runInContext('quizError', c.ctx), /could not be verified/);
});

function surveyFixture(c, {text='Skip survey', aria='', visible=true, disabled=false, context=null} = {}) {
  let clicks = 0;
  const button = {innerText:text, textContent:text, disabled, classList:{contains:()=>false},
    getAttribute:name=>name === 'aria-label' ? aria : null, getClientRects:()=>visible ? [1] : [],
    closest:selector=>selector.includes('[class*="survey"]') ? context : null,
    click:()=>{ clicks++; }};
  c.document.querySelectorAll = selector=>selector === 'button, a, [role="button"], [tabindex]' ? [button] : [];
  c.window.getComputedStyle = ()=>({display:'block',visibility:'visible',opacity:'1'});
  vm.runInContext('showHUD = () => {}', c.ctx);
  return {button,clicks:()=>clicks};
}

test('ordinary autoplay skips the player survey without bulk mode', async () => {
  const c = await content({bulkActive:false});
  const survey = surveyFixture(c);
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), true);
  assert.equal(survey.clicks(), 1);
  assert.equal(vm.runInContext('isBulkActive', c.ctx), false);
});

test('late survey is handled by the observer and the watchdog', async () => {
  for (const source of ['observer','watchdog']) {
    const c = await content({});
    const survey = surveyFixture(c);
    if (source === 'observer') c.mutations[0]();
    else c.intervals.at(-1)();
    assert.equal(survey.clicks(), 1);
  }
});

test('survey skip respects autoplay settings, Stop, and hidden/disabled controls', async () => {
  for (const options of [{autoplay:false},{autoNavigate:false},{skipNonVideos:false}]) {
    const c = await content(options);
    const survey = surveyFixture(c);
    assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), false);
    assert.equal(survey.clicks(), 0);
  }
  for (const options of [{visible:false},{disabled:true}]) {
    const c = await content({});
    const survey = surveyFixture(c, options);
    assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), false);
    assert.equal(survey.clicks(), 0);
  }
  const c = await content({});
  const survey = surveyFixture(c);
  c.runtime[0]({action:'stopBulkComplete'}, {}, noop);
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), false);
  assert.equal(survey.clicks(), 0);
});

test('generic Close is scoped to a matching survey and never closes a sidebar', async () => {
  const c = await content({});
  const sidebar = surveyFixture(c, {text:'Close'});
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), false);
  assert.equal(sidebar.clicks(), 0);
  const survey = surveyFixture(c, {text:'Close',context:{innerText:'How confident are you that you learned valuable skills from this course?'}});
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), true);
  assert.equal(survey.clicks(), 1);
});

test('survey skip reads aria labels and throttles clicks while dismissal is pending', async () => {
  const c = await content({});
  const survey = surveyFixture(c, {text:'',aria:'Skip survey'});
  c.ctx.timeNow = 1000;
  vm.runInContext('Date.now = () => timeNow', c.ctx);
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), true);
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), true);
  assert.equal(survey.clicks(), 1);
  c.ctx.timeNow = 2300;
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), true);
  assert.equal(survey.clicks(), 2);
});

test('survey handling never selects a numeric rating', async () => {
  const c = await content({});
  const rating = surveyFixture(c, {text:'5',context:{innerText:'How confident are you that you learned valuable skills from this course?'}});
  assert.equal(vm.runInContext('dismissSurveyIfPresent()', c.ctx), false);
  assert.equal(rating.clicks(), 0);
});


test('verified chapter quiz advances despite a stale sidebar completion marker', async () => {
  const c = await content({});
  chapterQuizFixture(c);
  const quizPath = c.window.location.pathname;
  const next = {href:'/learning/example/next', fullHref:'https://www.linkedin.com/learning/example/next?u=123&contextUrn=path', title:'Next lesson', completed:false, isVideo:true};
  c.ctx.fixtureSyllabus = () => [{href:quizPath, title:'Chapter Quiz', completed:false, isQuiz:true}, next];
  vm.runInContext('getCourseSyllabus = fixtureSyllabus', c.ctx);
  c.ctx.setTimeout = fn => setImmediate(fn);
  c.chrome.runtime.sendMessage = (message, callback) => {
    if (message.action === 'ASK_AI') callback({success:true, text:'{"answerIndices":[1],"answerTexts":["Second answer"]}'});
  };
  assert.equal(await vm.runInContext('solveLinkedInQuizWithGreenTickRetry(1)', c.ctx), true);
  assert.equal(c.window.location.href, next.fullHref);
});

test('ordinary autoplay continues a completed quiz once without bulk mode', async () => {
  const c = await content({});
  const quizPath = c.window.location.pathname;
  const next = {href:'/learning/example/next', fullHref:'https://www.linkedin.com/learning/example/next', title:'Next', completed:false, isVideo:true};
  c.ctx.fixtureSyllabus = () => [{href:quizPath, completed:false, isQuiz:true}, next];
  vm.runInContext('getCourseSyllabus = fixtureSyllabus; expandAllSections = () => {}', c.ctx);
  assert.equal(await vm.runInContext('continueAfterQuiz()', c.ctx), true);
  assert.equal(c.window.location.href, next.fullHref);
  assert.equal(await vm.runInContext('continueAfterQuiz()', c.ctx), false);
});

test('the last completed quiz returns to the learning path during autoplay', async () => {
  const url = 'https://www.linkedin.com/learning/paths/original';
  const c = await content({lastLearningPathUrl:url});
  vm.runInContext('getCourseSyllabus = () => [{href:window.location.pathname, completed:false, isQuiz:true}]; expandAllSections = () => {}', c.ctx);
  assert.equal(await vm.runInContext('continueAfterQuiz()', c.ctx), true);
  assert.equal(c.window.location.href, url);
});

test('Stop cancels quiz continuation while settings are being fetched', async () => {
  const c = await content({});
  let resolveSettings;
  c.chrome.storage.local.get = () => new Promise(resolve => {resolveSettings = resolve;});
  const pending = vm.runInContext('continueAfterQuiz()', c.ctx);
  vm.runInContext('quizRunEpoch++; quizAutoPaused = true; isBulkActive = false;', c.ctx);
  resolveSettings({});
  assert.equal(await pending, false);
  assert.equal(c.window.location.href, 'https://www.linkedin.com/learning/example/lesson');
});

test('All Paths opens My Content and preserves the organization query', async () => {
  const c = await content({});
  c.window.location.href += '?u=123';
  const result = await vm.runInContext('startAllPaths()', c.ctx);
  assert.equal(result.discovering, true);
  assert.equal(c.saved.pathQueueDiscoveryActive, true);
  assert.equal(c.saved.bulkActive, false);
  c.timers.at(-1)();
  assert.equal(c.window.location.href, 'https://www.linkedin.com/learning/me/my-library/in-progress?u=123');
});

test('All Paths persists discovery across library sections and deduplicates paths', async () => {
  const root = 'https://www.linkedin.com/learning/me/my-library/';
  const c = await content({}, root + 'in-progress');
  const link = name => ({textContent:name, getAttribute:() => '/learning/paths/' + name});
  const one = link('one'), two = link('two');
  const tabs = ['in-progress','saved'].map(name => ({getAttribute:() => root + name}));
  let savedSection = false;
  c.document.querySelectorAll = selector => {
    if (selector === 'a[href*="/learning/me/my-library/"]') return tabs;
    if (selector === 'main h3 a' || selector === 'main h3 a[href*="/learning/paths/"]') return savedSection ? [one,two] : [one];
    return [];
  };
  const first = await vm.runInContext('startAllPaths()', c.ctx);
  assert.equal(first.discovering, true);
  assert.equal(c.saved.pathQueueDiscovery.paths.length, 1);
  assert.equal(c.saved.pathQueueActive, false);
  c.timers.at(-1)();
  assert.equal(c.window.location.href, root + 'saved');
  c.window.location.pathname = '/learning/me/my-library/saved';
  savedSection = true;
  const second = await vm.runInContext('startAllPaths({resumeDiscovery:true})', c.ctx);
  assert.equal(second.totalPaths, 2);
  assert.equal(c.saved.pathQueueActive, true);
  assert.equal(c.saved.pathQueueDiscoveryActive, false);
  c.timers.at(-1)();
  assert.equal(c.window.location.href, 'https://www.linkedin.com/learning/paths/one');
});

test('discovery pauses the watchdog and Stop cancels pagination', async () => {
  const c = await content({}, 'https://www.linkedin.com/learning/me/my-library/in-progress');
  const one = {textContent:'One', getAttribute:() => '/learning/paths/one'};
  const more = {getAttribute:() => 'Show more in progress content', click:noop};
  c.document.querySelectorAll = selector => selector === 'main button' ? [more] : selector === 'main h3 a' ? [one] : [];
  c.ctx.escapeCount = 0;
  vm.runInContext('isElementClickable = () => true; runAutonomousStep = () => {escapeCount++;}', c.ctx);
  const pending = vm.runInContext('startAllPaths()', c.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('isDiscoveringPathQueue', c.ctx), true);
  assert.equal(vm.runInContext('isBulkActive', c.ctx), false);
  c.intervals.at(-1)();
  assert.equal(c.ctx.escapeCount, 0);
  c.runtime[0]({action:'stopBulkComplete'}, {}, noop);
  c.timers.at(-1)();
  assert.equal((await pending).success, false);
  assert.equal(c.saved.pathQueueDiscoveryActive, false);
  assert.equal(c.saved.pathQueueActive, false);
});

test('initialization resumes library discovery without restoring the course runner', async () => {
  const library = 'https://www.linkedin.com/learning/me/my-library/in-progress';
  const c = await content({bulkActive:true, pathQueueDiscoveryActive:true, pathQueueDiscovery:{sections:[library],visited:[],paths:[]}}, library);
  assert.equal(vm.runInContext('isDiscoveringPathQueue', c.ctx), true);
  assert.equal(vm.runInContext('isBulkActive', c.ctx), false);
  const one = {textContent:'One', getAttribute:() => '/learning/paths/one'};
  c.document.querySelectorAll = selector => selector === 'main h3 a' || selector === 'main h3 a[href*="/learning/paths/"]' ? [one] : [];
  await c.timers[0]();
  assert.equal(c.saved.pathQueueActive, true);
  assert.equal(c.saved.pathQueueDiscoveryActive, false);
  c.timers.at(-1)();
  assert.equal(c.window.location.href, 'https://www.linkedin.com/learning/paths/one');
});


function practiceResultFixture(c, completed = true) {
  const next = {href:'/learning/example/next', fullHref:'https://www.linkedin.com/learning/example/next', title:'Objects as sets', completed:false, isVideo:true};
  c.window.location.pathname = '/learning/example/quiz/current';
  c.window.location.href = 'https://www.linkedin.com' + c.window.location.pathname;
  let continueClicks = 0;
  const button = text => ({innerText:text, disabled:false, getClientRects:()=>[1], closest:()=>null, getAttribute:()=>null, click:()=>{continueClicks++;}});
  const main = {innerText:'You answered 2 of 4 questions correctly. Keep practicing! Review your answers and try again.',
    querySelector:()=>null, querySelectorAll:()=>[button('Review all answers'),button('Continue')], getClientRects:()=>[1]};
  c.document.querySelector = selector => selector === 'main, .classroom-layout__main, .classroom-body, [role="main"]' ? main : null;
  c.document.body = main;
  // Result pages can retain enabled question controls in review markup.
  c.document.querySelectorAll = selector => selector === '.chapter-quiz-question' ?
    [{getClientRects:()=>[1], querySelector:()=>({innerText:'Reviewed question'}), querySelectorAll:()=>[{disabled:false}]}] : [];
  c.ctx.fixtureSyllabus = () => [{href:c.window.location.pathname, title:'Chapter Quiz', completed, isQuiz:true}, next];
  vm.runInContext('getCourseSyllabus = fixtureSyllabus; expandAllSections = () => {}; showHUD = () => {}; sendProgress = () => {}; isElementClickable = () => true', c.ctx);
  return {main, next, clicks:()=>continueClicks};
}

test('Keep practicing result is recognized outside legacy quiz containers', async () => {
  const c = await content({});
  practiceResultFixture(c);
  assert.equal(vm.runInContext('getQuizResultState().visible', c.ctx), true);
  assert.equal(vm.runInContext('getQuizResultState().passed', c.ctx), false);
  assert.equal(vm.runInContext('hasActiveQuizQuestion()', c.ctx), false);
  assert.equal(await vm.runInContext('verifyQuizGreenTick(10)', c.ctx), true);
});

test('completed practice result resumes AutoPilot without review or AI requests', async () => {
  const c = await content({});
  const f = practiceResultFixture(c);
  let requests = 0;
  c.chrome.runtime.sendMessage = message => {if (message.action === 'ASK_AI') requests++;};
  vm.runInContext('isBulkActive = true', c.ctx);
  assert.equal(await vm.runInContext('solveLinkedInQuizWithGreenTickRetry(1)', c.ctx), true);
  assert.equal(c.window.location.href, f.next.fullHref);
  assert.equal(vm.runInContext('isBulkActive', c.ctx), true);
  assert.equal(vm.runInContext('quizError', c.ctx), null);
  assert.equal(requests, 0);
  assert.equal(f.clicks(), 0);
});

test('solver stops parsing reviewed questions once the current quiz is complete', async () => {
  const c = await content({});
  practiceResultFixture(c);
  c.ctx.setTimeout = fn => setImmediate(fn);
  vm.runInContext('parseCurrentQuizQuestion = () => {throw Error("Result must not be parsed as a question");}', c.ctx);
  assert.equal(await vm.runInContext('solveLinkedInQuiz()', c.ctx), true);
  assert.equal(vm.runInContext('quizError', c.ctx), null);
});

test('a partial score without a completion mark is not verified as completed', async () => {
  const c = await content({});
  practiceResultFixture(c, false);
  c.ctx.setTimeout = fn => setImmediate(fn);
  assert.equal(await vm.runInContext('verifyQuizGreenTick(10)', c.ctx), false);
});

test('Stop cancels result continuation during the verification storage wait', async () => {
  const c = await content({});
  const f = practiceResultFixture(c);
  let resolveSettings;
  c.chrome.storage.local.get = keys => keys.includes('focusMode') ? new Promise(resolve => {resolveSettings = resolve;}) : Promise.resolve(c.saved);
  const pending = vm.runInContext('solveLinkedInQuizWithGreenTickRetry(1)', c.ctx);
  await new Promise(resolve => setImmediate(resolve));
  c.runtime[0]({action:'stopBulkComplete'}, {}, noop);
  resolveSettings({});
  assert.equal(await pending, true);
  assert.notEqual(c.window.location.href, f.next.fullHref);
  assert.equal(vm.runInContext('isBulkActive', c.ctx), false);
});

test('ordinary quiz questions still override old sidebar completion marks', async () => {
  const c = await content({});
  chapterQuizFixture(c);
  vm.runInContext('getCourseSyllabus = () => [{href:window.location.pathname, completed:true}]', c.ctx);
  assert.equal(vm.runInContext('getQuizResultState().visible', c.ctx), false);
  assert.equal(await vm.runInContext('verifyQuizGreenTick(10)', c.ctx), false);
});


test('server-confirmed completion advances a quiz with a stale sidebar marker', async () => {
  const c = await content({});
  const f = practiceResultFixture(c, false);
  vm.runInContext("networkCompletionSignals.set(window.location.pathname, {kind:'quiz',startedAt:Date.now(),observedAt:Date.now()}); isBulkActive=true",c.ctx);
  assert.equal(await vm.runInContext('solveLinkedInQuizWithGreenTickRetry(1)',c.ctx),true);
  assert.equal(c.window.location.href,f.next.fullHref);
  assert.equal(vm.runInContext('isBulkActive',c.ctx),true);
});

test('network evidence for another quiz cannot complete the current quiz', async () => {
  const c = await content({}); practiceResultFixture(c,false);
  c.ctx.setTimeout = fn => setImmediate(fn);
  vm.runInContext("networkCompletionSignals.set('/learning/example/quiz/other', {kind:'quiz',startedAt:Date.now(),observedAt:Date.now()})",c.ctx);
  assert.equal(await vm.runInContext('verifyQuizGreenTick(10)',c.ctx),false);
});

function statusRow({title='',text='',marker=null,aria=''}={}) {
 const link={innerText:title,hasAttribute:()=>marker!==null,getAttribute:()=>marker};
 const row={innerText:text,className:'',closest:()=>row,getAttribute:name=>name==='aria-label'?aria:null,
 querySelector:selector=>selector==='a.classroom-toc-item__link'?link:null,querySelectorAll:()=>[]};
 return row;
}
test('explicit false Viewed marker does not complete an unfinished lesson',async()=>{
 const c=await content({});c.ctx.row=statusRow({title:'Chapter Quiz',text:'Chapter Quiz 9 questions',marker:'false'});
 assert.equal(vm.runInContext('isLessonCompleted(row)',c.ctx),false);
});
test('completion words in a lesson title are not completion status',async()=>{
 const c=await content({});c.ctx.row=statusRow({title:'Completed projects',text:'Completed projects\n3m 14s video'});
 assert.equal(vm.runInContext('isLessonCompleted(row)',c.ctx),false);
});
test('Not passed status overrides a positive-looking completion label',async()=>{
 const c=await content({});c.ctx.row=statusRow({title:'Chapter Quiz',text:'Chapter Quiz\nNot passed',aria:'Completed'});
 assert.equal(vm.runInContext('isLessonCompleted(row)',c.ctx),false);
});
test('completion status remains valid when it is separate from the title',async()=>{
 const c=await content({});c.ctx.row=statusRow({title:'Completed projects',text:'Completed projects\nViewed'});
 assert.equal(vm.runInContext('isLessonCompleted(row)',c.ctx),true);
});
test('unanswered extension request times out rather than locking a workflow forever',async()=>{
 const c=await content({});const pending=vm.runInContext("sendRuntimeRequest({action:'ASK_AI'},100)",c.ctx);
 const rejected=assert.rejects(pending,/timed out/);c.timers.at(-1)();await rejected;
});
test('extension callback failures are surfaced to the caller',async()=>{
 const c=await content({});
 c.chrome.runtime.sendMessage=(message,reply)=>{c.chrome.runtime.lastError={message:'Receiving end does not exist'};reply();delete c.chrome.runtime.lastError;};
 await assert.rejects(vm.runInContext("sendRuntimeRequest({action:'ASK_AI'})",c.ctx),/Receiving end/);
});
test('Stop through storage cancels work in a background tab',async()=>{
 const c=await content({});vm.runInContext('isBulkActive=true; quizAutoPaused=false',c.ctx);
 const epoch=vm.runInContext('quizRunEpoch',c.ctx);
 c.storage[0]({bulkActive:{oldValue:true,newValue:false}},'local');
 assert.equal(vm.runInContext('isBulkActive',c.ctx),false);
 assert.equal(vm.runInContext('quizAutoPaused',c.ctx),true);
 assert.ok(vm.runInContext('quizRunEpoch',c.ctx)>epoch);
});
test('path discovery can turn bulk off without cancelling its own discovery',async()=>{
 const c=await content({});vm.runInContext('isBulkActive=false; isDiscoveringPathQueue=true; quizAutoPaused=false',c.ctx);
 const epoch=vm.runInContext('quizRunEpoch',c.ctx);
 c.storage[0]({bulkActive:{oldValue:true,newValue:false}},'local');
 assert.equal(vm.runInContext('quizAutoPaused',c.ctx),false);
 assert.equal(vm.runInContext('quizRunEpoch',c.ctx),epoch);
});
test('changing preferredProvider clears the quiz error for retry',async()=>{
 const c=await content({});vm.runInContext("quizError='old provider failure'; quizAutoPaused=true; checkAndAutoSolveQuiz=()=>{}",c.ctx);
 c.storage[0]({preferredProvider:{newValue:'groq'}},'local');
 assert.equal(vm.runInContext('quizError',c.ctx),null);
 assert.equal(vm.runInContext('quizAutoPaused',c.ctx),false);
});
test('HUD treats an error message as plain text',async()=>{
 const c=await content({});const hud={style:{},innerHTML:'unchanged'};
 c.document.getElementById=()=>hud;c.ctx.message='<img src=x onerror=alert(1)>';
 vm.runInContext("showHUD(message,'warn')",c.ctx);
 assert.equal(hud.innerHTML,'unchanged');assert.ok(hud.textContent.includes(c.ctx.message));
});
test('a delayed skip does not run after switching into a quiz',async()=>{
 const c=await content({});let navigations=0;c.ctx.navigate=()=>{navigations++;};
 vm.runInContext('getCourseSyllabus=()=>[]; isQuizOnPage=()=>false; goToNextLesson=navigate; runPlaybackWatchdog()',c.ctx);
 const skip=c.timers.at(-1);c.window.location.pathname='/learning/example/quiz/one';
 vm.runInContext('isQuizOnPage=()=>true',c.ctx);skip();assert.equal(navigations,0);
});
test('a delayed skip waits if the syllabus identifies a loading video',async()=>{
 const c=await content({});let navigations=0;c.ctx.navigate=()=>{navigations++;};
 vm.runInContext('getCourseSyllabus=()=>[]; isQuizOnPage=()=>false; goToNextLesson=navigate; runPlaybackWatchdog()',c.ctx);
 const skip=c.timers.at(-1);vm.runInContext('getCourseSyllabus=()=>[{href:window.location.pathname,isVideo:true}]',c.ctx);
 skip();assert.equal(navigations,0);
});
test('navigation fallback can recover from a throttled timer using elapsed time',async()=>{
 const c=await content({});c.ctx.lesson={href:'/learning/example/next',fullHref:'https://www.linkedin.com/learning/example/next',
 element:{isConnected:true,click:noop}};
 vm.runInContext('isBulkActive=true; navigateToLesson(lesson); pendingLessonNavigation.startedAt=Date.now()-5000; recoverPendingLessonNavigation()',c.ctx);
 assert.equal(c.window.location.href,c.ctx.lesson.fullHref);
});
test('an old navigation timer cannot override a new destination',async()=>{
 const c=await content({});c.ctx.first={href:'/learning/example/first',element:{isConnected:true,click:noop}};
 c.ctx.second={href:'/learning/example/second',element:{isConnected:true,click:noop}};
 vm.runInContext('isBulkActive=true; navigateToLesson(first)',c.ctx);const old=c.timers.at(-1);
 vm.runInContext('navigateToLesson(second)',c.ctx);old();
 assert.equal(c.window.location.href,'https://www.linkedin.com/learning/example/lesson');
});
test('invalidated extension context stops timers and asks for a tab refresh',async()=>{
 const c=await content({});let notice='';c.ctx.notice=message=>{notice=message;};
 vm.runInContext('showHUD=notice; isBulkActive=true',c.ctx);delete c.chrome.runtime.id;
 vm.runInContext('runPlaybackWatchdog()',c.ctx);
 assert.equal(vm.runInContext('extensionContextStopped',c.ctx),true);
 assert.equal(vm.runInContext('isBulkActive',c.ctx),false);assert.match(notice,/Refresh/);
 assert.equal(c.saved.bulkActive,undefined);
});

test('false Viewed marker stays incomplete despite a stale completed class',async()=>{
 const c=await content({});c.ctx.row=statusRow({title:'Chapter Quiz',text:'Chapter Quiz 9 questions',marker:'false'});
 c.ctx.row.className='classroom-toc-item--completed';assert.equal(vm.runInContext('isLessonCompleted(row)',c.ctx),false);
});
test('queued path advancement from an old run cannot move a newly started run',async()=>{
 const c=await content({},'https://www.linkedin.com/learning/paths/one');
 let resolve;const gate=new Promise(r=>{resolve=r;});c.chrome.storage.local.get=async()=>gate;
 vm.runInContext('isBulkActive=true',c.ctx);const pending=vm.runInContext('advancePathQueue()',c.ctx);
 vm.runInContext('quizRunEpoch++; isBulkActive=true',c.ctx);
 resolve({pathQueueActive:true,pathQueueIndex:0,pathQueue:[{url:c.window.location.href},{url:'https://www.linkedin.com/learning/paths/two'}]});
 assert.equal(await pending,false);assert.equal(c.window.location.href,'https://www.linkedin.com/learning/paths/one');
});
test('malformed queued paths are rejected without throwing',async()=>{
 const c=await content({},'https://www.linkedin.com/learning/paths/one');
 c.chrome.storage.local.get=async()=>({pathQueueActive:true,pathQueue:[{url:'https://other.example/learning/paths/one'}]});
 vm.runInContext('isBulkActive=true',c.ctx);assert.equal(await vm.runInContext('advancePathQueue()',c.ctx),false);
});

test('check-circle icon confirms completion rather than being treated as an empty circle',async()=>{
 const c=await content({});const row=statusRow({text:'Chapter Quiz 4 questions'});
 const icon={getAttribute:name=>name==='type'?'check-circle':null};
 row.querySelectorAll=selector=>selector==='li-icon, [data-test-icon], [data-icon]'?[icon]:[];
 c.ctx.row=row;assert.equal(vm.runInContext('isLessonCompleted(row)',c.ctx),true);
});
test('unchecked checkbox icon is not mistaken for a completion check',async()=>{
 const c=await content({});const row=statusRow({text:'Chapter Quiz 4 questions'});
 const icon={getAttribute:name=>name==='type'?'checkbox-unchecked':null};
 row.querySelectorAll=selector=>selector==='li-icon, [data-test-icon], [data-icon]'?[icon]:[];
 c.ctx.row=row;assert.equal(vm.runInContext('isLessonCompleted(row)',c.ctx),false);
});

test('AI text matching tolerates smart quotes and nonbreaking whitespace',async()=>{
 const c=await content({});c.ctx.q={type:'radio',options:[{text:"Use the recipient's first name."},{text:'Send generic email.'}]};
 c.ctx.answer={answerIndices:[0],answerTexts:["Use the recipient’s\u00a0first name."]};
 assert.deepEqual(Array.from(vm.runInContext('resolveAnswerIndices(q,answer)',c.ctx)),[0]);
});
test('numeric JSON string indices normalize without changing index base',async()=>{
 const c=await content({});c.ctx.raw='{"answerIndices":["1"],"answerTexts":["Second"]}';
 c.ctx.q={type:'radio',options:[{text:'First'},{text:'Second'}]};
 assert.deepEqual(Array.from(vm.runInContext('resolveAnswerIndices(q,parseAIAnswerPayload(raw))',c.ctx)),[1]);
});
test('common scalar and snake-case JSON fields normalize to the required schema',async()=>{
 const c=await content({});c.ctx.q={type:'radio',options:[{text:'First'},{text:'Second'}]};
 for(const raw of ['{"answerIndex":1,"answerText":"Second"}','{"answer_indices":["1"],"answer_texts":["Second"]}']){
 c.ctx.raw=raw;assert.deepEqual(Array.from(vm.runInContext('resolveAnswerIndices(q,parseAIAnswerPayload(raw))',c.ctx)),[1]);
 }
});
test('format normalization preserves mathematical negation',async()=>{
 const c=await content({});c.ctx.q={type:'radio',options:[{text:'\\neg A'},{text:'A'}]};c.ctx.answer={answerTexts:['A']};
 assert.deepEqual(Array.from(vm.runInContext('resolveAnswerIndices(q,answer)',c.ctx)),[1]);
});
test('one-based conflicts and partial text-only answers remain blocked',async()=>{
 const c=await content({});c.ctx.q={type:'radio',options:[{text:'First'},{text:'Second'}]};
 for(const answer of [{answerIndices:[1],answerTexts:['First']},{answerTexts:['Fir']}]){
 c.ctx.answer=answer;assert.equal(vm.runInContext('resolveAnswerIndices(q,answer).length',c.ctx),0);
 assert.equal(vm.runInContext('getAIRepairSelection(q,answer).length',c.ctx),0);
 }
});
test('format repair happens once and preserves an identified answer index',async()=>{
 const c=await content({});c.ctx.q={prompt:'Which action?',type:'radio',options:[{text:'First choice'},{text:'Second choice'}]};
 const replies=['{"answerIndices":[1],"answerTexts":["Second choice (selected)"]}','{"answerIndices":[1],"answerTexts":["Second choice"]}'];
 let calls=0;c.chrome.runtime.sendMessage=(message,reply)=>{if(message.action==='ASK_AI')reply({success:true,text:replies[calls++],provider:'fixture'});};
 const answer=await vm.runInContext('askAIForQuestion(q)',c.ctx);assert.equal(calls,2);assert.equal(answer.answerIndices[0],1);
});
test('format repair may not change the original selected index',async()=>{
 const c=await content({});c.ctx.q={prompt:'Which action?',type:'radio',options:[{text:'First choice'},{text:'Second choice'}]};
 const replies=['{"answerIndices":[1],"answerTexts":["Second choice (selected)"]}','{"answerIndices":[0],"answerTexts":["First choice"]}'];
 let calls=0;c.chrome.runtime.sendMessage=(message,reply)=>{if(message.action==='ASK_AI')reply({success:true,text:replies[calls++]});};
 await assert.rejects(vm.runInContext('askAIForQuestion(q)',c.ctx),/did not match/);assert.equal(calls,2);
});
test('ambiguous response is rejected without a format repair request',async()=>{
 const c=await content({});c.ctx.q={prompt:'Which action?',type:'radio',options:[{text:'First choice'},{text:'First choice with more detail'}]};
 let calls=0;c.chrome.runtime.sendMessage=(message,reply)=>{if(message.action==='ASK_AI'){calls++;reply({success:true,text:'{"answerTexts":["First choice with"]}'});}};
 await assert.rejects(vm.runInContext('askAIForQuestion(q)',c.ctx),/did not match/);assert.equal(calls,1);
});
test('Stop during the initial response prevents format repair',async()=>{
 const c=await content({});c.ctx.q={prompt:'Which action?',type:'radio',options:[{text:'First'},{text:'Second'}]};
 let calls=0;c.chrome.runtime.sendMessage=(message,reply)=>{
 if(message.action==='ASK_AI'){calls++;vm.runInContext('quizRunEpoch++;quizAutoPaused=true',c.ctx);reply({success:true,text:'{"answerIndices":[1],"answerTexts":["Second (selected)"]}'});}
 };
 await assert.rejects(vm.runInContext('askAIForQuestion(q)',c.ctx),/cancelled/);assert.equal(calls,1);
});
