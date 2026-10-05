const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const bg=fs.readFileSync(path.join(__dirname,'..','background.js'),'utf8');
const content=fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8');
const noop=()=>{};
const drain=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function supervisor({alarmExists=true,hangFirst=false}={}) {
  const events={},timers=[],messages=[],updates=[];
  let rows={'1':{originalAutoDiscardable:true,lastSeen:1000},'2':{originalAutoDiscardable:true,lastSeen:1000}};
  let alarm=alarmExists?{}:null,creates=0;
  const api={
    runtime:{onMessage:{addListener:fn=>{events.message=fn;}}},
    storage:{session:{get:async()=>({learningBackgroundTabs:structuredClone(rows)}),set:async value=>{rows=structuredClone(value.learningBackgroundTabs);}},onChanged:{addListener:noop}},
    tabs:{get:async id=>({id,url:'https://www.linkedin.com/learning/course/lesson',autoDiscardable:false}),
      update:async(id,value)=>updates.push({id,value}),
      sendMessage:async id=>{messages.push(id);if(hangFirst&&id===1)return new Promise(()=>{});return {active:true};},
      onUpdated:{addListener:fn=>{events.updated=fn;}},onRemoved:{addListener:noop}},
    alarms:{get:async()=>alarm,create:async()=>{creates++;alarm={};},clear:async()=>{alarm=null;},onAlarm:{addListener:fn=>{events.alarm=fn;}}}
  };
  const source=bg.slice(bg.indexOf('function sendBackgroundPulseWithTimeout('),bg.lastIndexOf('installBackgroundSupervisor(chrome);'));
  new Function('setTimeout','clearTimeout','Date','URL',source+';return installBackgroundSupervisor;')(
    fn=>{const entry={fn,cancelled:false};timers.push(entry);return entry;},
    entry=>{entry.cancelled=true;},{now:()=>1000},URL)(api);
  return {events,timers,messages,updates,creates:()=>creates,rows:()=>rows};
}
test('an existing alarm is preserved across startup and page updates',async()=>{
  const f=supervisor();await drain();assert.equal(f.creates(),0);
  f.events.updated(1,{status:'complete'});await drain();assert.equal(f.creates(),0);
});
test('a missing alarm is created once and is not postponed by pulses',async()=>{
  const f=supervisor({alarmExists:false});await drain();assert.equal(f.creates(),1);
  f.events.alarm({name:'learning-background-pulse'});await drain();assert.equal(f.creates(),1);
});
test('an unresponsive tab cannot block supervision of the next tab',async()=>{
  const f=supervisor({hangFirst:true});await drain();
  f.events.alarm({name:'learning-background-pulse'});await drain();
  assert.equal(f.messages.join(','),'1');
  f.timers.find(t=>!t.cancelled).fn();await drain();
  assert.equal(f.messages.join(','),'1,2');
});
test('a registration queued behind a stuck pulse proceeds after timeout',async()=>{
  const f=supervisor({hangFirst:true});await drain();
  f.events.alarm({name:'learning-background-pulse'});await drain();
  let acknowledged=false;
  f.events.message({action:'backgroundRunState',enabled:true},{tab:{id:3},frameId:0},()=>{acknowledged=true;});
  assert.equal(acknowledged,false);
  f.timers.find(t=>!t.cancelled).fn();await drain();
  assert.equal(acknowledged,true);assert.equal(!!f.rows()['3'],true);
});
test('successful tab replies cancel their timeout',async()=>{
  const f=supervisor();await drain();f.events.alarm({name:'learning-background-pulse'});await drain();
  assert.equal(f.messages.join(','),'1,2');assert.equal(f.timers.every(t=>t.cancelled),true);
});
function watchdogFixture({locked=true,paused=true,quiz=false}={}) {
  let plays=0;
  const video={paused,ended:false};
  const globals={
    isExtensionContextActive:()=>true,recoverPendingLessonNavigation:()=>{},syncBackgroundSupervision:noop,handleExternalPathItem:()=>false,recoverBlockedPlayback:()=>false,document:{querySelector:()=>video},
    videoEl:video,attachToVideo:noop,isDiscoveringPathQueue:false,isBulkActive:true,
    isQuizOnPage:()=>quiz,requestManagedPlayback:()=>{plays++;},
    dismissSurveyIfPresent:()=>false,isRunningAutonomousStep:locked,isNavigatingToLesson:false,
    isSolvingQuiz:false,isQuizWorkflowRunning:false,speedInjectionEnabled:false
  };
  const begin=content.indexOf('function runPlaybackWatchdog()');
  const end=content.indexOf('// ─── Video Attachment',begin);
  const run=new Function(...Object.keys(globals),content.slice(begin,end)+';return runPlaybackWatchdog;')(...Object.values(globals));
  return {run,plays:()=>plays};
}
test('a paused video resumes even while the autonomous step is awaiting a response',()=>{
  const f=watchdogFixture();f.run();assert.equal(f.plays(),1);
});
test('active quiz pages do not start their underlying video',()=>{
  const f=watchdogFixture({quiz:true});f.run();assert.equal(f.plays(),0);
});
test('already playing video is left alone during a workflow lock',()=>{
  const f=watchdogFixture({paused:false});f.run();assert.equal(f.plays(),0);
});
