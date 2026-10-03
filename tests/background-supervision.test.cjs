const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const supervisor = background.slice(background.indexOf('function installBackgroundSupervisor'));
const install = vm.runInNewContext(supervisor.replace('installBackgroundSupervisor(chrome);', '') + '\ninstallBackgroundSupervisor', {URL, Date});

function fixture(initial = {}) {
  const session = JSON.parse(JSON.stringify(initial)), handlers = {}, updates = [], messages = [], alarms = {};
  const tabs = {1:{id:1,url:'https://www.linkedin.com/learning/example/lesson',autoDiscardable:true},
    2:{id:2,url:'https://www.linkedin.com/learning/example/lesson',autoDiscardable:false}};
  let response = {active:true}, fail = false;
  const event = name => ({addListener: fn => {handlers[name] = fn;}});
  const api = {
    runtime:{onMessage:event('message')},
    alarms:{onAlarm:event('alarm'), create:async (name, opts) => {alarms[name] = opts;}, clear:async name => {delete alarms[name];}},
    storage:{session:{get:async () => JSON.parse(JSON.stringify(session)),set:async data => Object.assign(session,JSON.parse(JSON.stringify(data)))},onChanged:event('storage')},
    tabs:{onUpdated:event('updated'),onRemoved:event('removed'), get:async id => {if(!tabs[id])throw Error('closed');return {...tabs[id]};},
      update:async (id, change) => {updates.push([id,change]);Object.assign(tabs[id],change);},
      sendMessage:async (id,message) => {messages.push([id,message]);if(fail)throw Error('loading');return response;}}
  };
  install(api);
  const register = (id, enabled) => new Promise(resolve => handlers.message({action:'backgroundRunState',enabled},{tab:{id},frameId:0},resolve));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {api,session,tabs,handlers,updates,messages,alarms,register,flush,
    setResponse:value=>{response=value;},setFailure:value=>{fail=value;}};
}

test('active learning tabs are protected and original discard preferences restore on Stop', async () => {
  const f = fixture();
  await f.register(1,true); await f.register(2,true);
  assert.equal(f.tabs[1].autoDiscardable,false);
  assert.equal(f.alarms['learning-background-pulse'].periodInMinutes,0.5);
  await f.register(1,false); await f.register(2,false);
  assert.equal(f.tabs[1].autoDiscardable,true);
  assert.equal(f.tabs[2].autoDiscardable,false);
  assert.deepEqual(f.session.learningBackgroundTabs,{});
  assert.equal(f.alarms['learning-background-pulse'],undefined);
});

test('alarm nudges registered tabs and releases completed runs without activating a tab', async () => {
  const f = fixture(); await f.register(1,true);
  f.handlers.alarm({name:'learning-background-pulse'}); await f.flush();
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0][1].action,'backgroundPulse');
  f.setResponse({active:false});
  f.handlers.alarm({name:'learning-background-pulse'}); await f.flush();
  assert.equal(f.tabs[1].autoDiscardable,true);
  assert.equal(f.updates.some(([,change]) => 'active' in change),false);
});

test('session registrations survive worker restarts and recreate the alarm', async () => {
  const f = fixture({learningBackgroundTabs:{1:{originalAutoDiscardable:true,lastSeen:Date.now()}}});
  await f.flush();
  assert.equal(f.alarms['learning-background-pulse'].periodInMinutes,0.5);
  f.handlers.alarm({name:'learning-background-pulse'}); await f.flush();
  assert.equal(f.messages.length,1);
});

test('leaving Learning or disabling background play restores tab discardability', async () => {
  const f = fixture(); await f.register(1,true);
  f.tabs[1].url = 'https://www.linkedin.com/feed/';
  f.handlers.updated(1,{url:f.tabs[1].url}); await f.flush();
  assert.equal(f.tabs[1].autoDiscardable,true);
  await f.register(2,true);
  f.handlers.storage({bgPlay:{newValue:false}},'local'); await f.flush();
  assert.deepEqual(f.session.learningBackgroundTabs,{});
});

test('transient page loads keep protection but abandoned registrations expire', async () => {
  const f = fixture(); await f.register(1,true); f.setFailure(true);
  f.handlers.alarm({name:'learning-background-pulse'}); await f.flush();
  assert.equal(f.tabs[1].autoDiscardable,false);
  f.session.learningBackgroundTabs[1].lastSeen = Date.now()-121000;
  f.handlers.alarm({name:'learning-background-pulse'}); await f.flush();
  assert.equal(f.tabs[1].autoDiscardable,true);
  assert.deepEqual(f.session.learningBackgroundTabs,{});
});

test('unrelated pages cannot register for protection', async () => {
  const f = fixture(); f.tabs[1].url = 'https://example.com/learning/example';
  await f.register(1,true);
  assert.equal(f.updates.length,0);
  assert.deepEqual(f.session.learningBackgroundTabs,{});
});


const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
test('background supervision honors Stop, background toggle and active playback', () => {
  const start = contentSource.indexOf('let backgroundRegistration = null;');
  const end = contentSource.indexOf('function startWatchdog()', start);
  const state = {backgroundRun:true,quizAutoPaused:false,isBulkActive:true,isDiscoveringPathQueue:false,
    isSolvingQuiz:false,isQuizWorkflowRunning:false,autoplayEnabled:true,videoEl:null};
  const should = vm.runInNewContext(contentSource.slice(start,end) + '\nshouldSuperviseBackgroundRun', state);
  assert.equal(!!should(),true);
  state.quizAutoPaused = true; assert.equal(!!should(),false);
  state.quizAutoPaused = false; state.backgroundRun = false; assert.equal(!!should(),false);
  state.backgroundRun = true; state.isBulkActive = false; assert.equal(!!should(),false);
  state.videoEl = {ended:false}; assert.equal(!!should(),true);
  state.videoEl.ended = true; assert.equal(!!should(),false);
});

test('background AutoPilot suppresses routine HUD creation', () => {
  const start = contentSource.indexOf('function showHUD('), end = contentSource.indexOf('function isElementClickable',start);
  let created = 0;
  const show = vm.runInNewContext(contentSource.slice(start,end) + '\nshowHUD', {
    backgroundRun:true,isBulkActive:true,isDiscoveringPathQueue:false,
    document:{body:{},getElementById:()=>null,createElement:()=>{created++;throw Error('routine HUD should be quiet');}}
  });
  show('Working...');
  assert.equal(created,0);
});

test('duplicate progress is coalesced while completion and errors are immediate', () => {
  const start = contentSource.indexOf("let lastProgressSignature = ''"), end = contentSource.indexOf('let hudTimeout',start);
  const messages = [];
  const send = vm.runInNewContext(contentSource.slice(start,end) + '\nsendProgress', {
    chrome:{runtime:{sendMessage:message=>messages.push(message)}},Date:{now:()=>1000}
  });
  send({message:'Playing'}); send({message:'Playing'});
  assert.equal(messages.length,1);
  send({error:true,message:'Playback blocked'}); send({error:true,message:'Playback blocked'});
  send({isDone:true}); send({isDone:true});
  assert.equal(messages.length,5);
});
