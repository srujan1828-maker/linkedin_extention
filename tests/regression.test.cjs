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
  const listeners = {};
  const document = Object.create({ get hidden() { return true; }, get visibilityState() { return 'hidden'; } });
  Object.assign(document, { querySelector: () => video, querySelectorAll: () => [video], addEventListener: noop });
  const window = { addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) };
  vm.runInNewContext(source('page-inject.js'), { window, document, HTMLMediaElement: Media, console, setInterval: noop, setTimeout: noop });
  const message = data => listeners.message.forEach(fn => fn({ source: window, data }));
  return { video, document, window, message, listeners };
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

async function content(saved) {
  const messages = [], runtime = [], storage = [], timers = [];
  let attached = 0;
  const document = { body: {}, hidden: false, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop };
  const window = { location: { href: 'https://www.linkedin.com/learning/example/lesson', pathname: '/learning/example/lesson', origin: 'https://www.linkedin.com' }, addEventListener: noop, postMessage: m => messages.push(m) };
  const chrome = {
    runtime: { id: 'test', connect: () => ({ onDisconnect: { addListener: noop }, postMessage: noop }), onMessage: { addListener: fn => runtime.push(fn) }, sendMessage: noop },
    storage: { local: { get: async () => saved, set: noop }, onChanged: { addListener: fn => storage.push(fn) } }
  };
  const ctx = vm.createContext({ window, document, chrome, console, AbortController, setInterval: noop, clearInterval: noop, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: noop, MutationObserver: class { constructor() { attached++; } observe() {} } });
  vm.runInContext(source('content.js'), ctx);
  assert.equal(attached, 0, 'player observation must wait for saved settings');
  await new Promise(resolve => setImmediate(resolve));
  return { ctx, messages, runtime, storage, timers, attached };
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
