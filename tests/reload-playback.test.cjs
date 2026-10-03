const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8');
const begin=source.indexOf('function createManagedPlayback(');
const end=source.indexOf('const managedPlayback =',begin);
const create=new Function(source.slice(begin,end)+';return createManagedPlayback;')();
function fixture(play) {
  let now=10000, allowed=true;
  const notices=[],blocked=[];
  const video={paused:true,ended:false,readyState:4,muted:false,calls:0,async play(){this.calls++;await play?.(this);this.paused=false;}};
  const request=create({now:()=>now,onMuted:(v,m)=>notices.push(m),onBlocked:e=>blocked.push(e)});
  return {video,request:()=>request(video,()=>allowed),stop:()=>{allowed=false;},advance:()=>{now+=2000;},notices,blocked};
}
test('restored ready video starts automatically without muting',async()=>{
  const f=fixture();assert.equal(await f.request(),true);assert.equal(f.video.calls,1);assert.equal(f.video.muted,false);
});
test('autoplay rejection retries muted and reports the fallback',async()=>{
  const f=fixture(v=>{if(!v.muted)throw Object.assign(Error('gesture'),{name:'NotAllowedError'});});
  assert.equal(await f.request(),true);assert.equal(f.video.calls,2);assert.equal(f.video.muted,true);assert.equal(f.notices.length,1);
});
test('failed muted retry restores sound and reports a blocked player',async()=>{
  const f=fixture(()=>{throw Object.assign(Error('gesture'),{name:'NotAllowedError'});});
  assert.equal(await f.request(),false);assert.equal(f.video.muted,false);assert.equal(f.blocked.length,1);
});
test('Stop during rejected play prevents the muted retry',async()=>{
  let f;f=fixture(()=>{f.stop();throw Object.assign(Error('gesture'),{name:'NotAllowedError'});});
  assert.equal(await f.request(),false);assert.equal(f.video.calls,1);assert.equal(f.video.muted,false);
});
test('buffering with a source can be started before canplay',async()=>{
  const f=fixture();f.video.readyState=0;f.video.currentSrc='blob:player';
  assert.equal(await f.request(),true);assert.equal(f.video.calls,1);
});
test('player without media data or a source waits for readiness',async()=>{
  const f=fixture();f.video.readyState=0;
  assert.equal(await f.request(),false);assert.equal(f.video.calls,0);
  f.video.readyState=2;assert.equal(await f.request(),true);
});
test('concurrent attempts serialize and rejected attempts wait two seconds',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});
  const f=fixture(()=>pending);const first=f.request();
  assert.equal(await f.request(),false);assert.equal(f.video.calls,1);
  resolve();assert.equal(await first,true);
  f.video.paused=true;assert.equal(await f.request(),false);
  f.advance();assert.equal(await f.request(),true);assert.equal(f.video.calls,2);
});
test('non-autoplay errors do not change the mute preference',async()=>{
  const f=fixture(()=>{throw Object.assign(Error('buffering'),{name:'AbortError'});});
  assert.equal(await f.request(),false);assert.equal(f.video.calls,1);assert.equal(f.video.muted,false);
});
test('an already-muted player is not redundantly retried',async()=>{
  const f=fixture(()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});});f.video.muted=true;
  assert.equal(await f.request(),false);assert.equal(f.video.calls,1);assert.equal(f.video.muted,true);
});

function reloadFixture() {
  const calls=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const begin=source.indexOf('async function reloadForPlaybackRecovery()');
  const end=source.indexOf('const log =',begin);
  const window={location:{pathname:'/learning/course/video',reload:()=>calls.push('reload')}};
  const chrome={storage:{local:{set:async data=>{calls.push('checkpoint');await gate;}}}};
  const addLog=async()=>{calls.push('log');};
  const state="let recoveryReloadInFlight=false,quizAutoPaused=false,quizRunEpoch=0,isBulkActive=true,autoplayEnabled=true,backgroundRun=true;";
  const api=new Function('window','chrome','addLog',state+source.slice(begin,end)+';return {reload:reloadForPlaybackRecovery,stop:()=>{quizRunEpoch++;quizAutoPaused=true;}};')(window,chrome,addLog);
  return {...api,calls,release};
}
test('recovery persists settings before reloading',async()=>{
  const f=reloadFixture();const run=f.reload();
  assert.equal(f.calls.join(','),'checkpoint');
  f.release();await run;assert.equal(f.calls.join(','),'checkpoint,log,reload');
});
test('Stop during checkpoint cancels the reload',async()=>{
  const f=reloadFixture();const run=f.reload();f.stop();f.release();await run;
  assert.equal(f.calls.join(','),'checkpoint');
});
test('parallel watchdog ticks do not duplicate recovery reloads',async()=>{
  const f=reloadFixture();const first=f.reload();await f.reload();
  assert.equal(f.calls.join(','),'checkpoint');f.release();await first;
  assert.equal(f.calls.join(','),'checkpoint,log,reload');
});
