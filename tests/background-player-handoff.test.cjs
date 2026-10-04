const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','page-inject.js'),'utf8');
function fixture(initialReadyState=4) {
  let hidden=true, now=10000;
  const listeners={}, windowListeners={}, timers=[], messages=[];
  class Media {
    constructor(){this.tagName='VIDEO';this.paused=true;this.ended=false;this.isConnected=true;this.readyState=4;this.calls=0;this.rate=1;}
    get playbackRate(){return this.rate;}
    set playbackRate(v){this.rate=v;}
    addEventListener(){}
    setAttribute(key,value){(this.attributes ||= {})[key]=value;}
    getAttribute(key){return this.attributes?.[key] ?? null;}
    removeAttribute(key){delete this.attributes?.[key];}
    async play(){this.calls++;this.paused=false;}
  }
  const video=new Media(); video.readyState=initialReadyState;
  const document=Object.create({get hidden(){return hidden;}});
  Object.assign(document,{hasFocus:()=>!hidden,querySelectorAll:()=>[video],querySelector:()=>video,
    addEventListener:(type,fn)=>(listeners[type] ||= []).push(fn)});
  const window={location:{pathname:'/learning/course/video',origin:'https://www.linkedin.com'},postMessage(data){messages.push(data);},addEventListener:(type,fn)=>(windowListeners[type] ||= []).push(fn)};
  new Function('window','document','HTMLMediaElement','setTimeout','setInterval','console','Date',source)(
    window,document,Media,fn=>timers.push(fn),()=>{}, {log(){},warn(){},error(){}},{now:()=>now});
  const message=data=>(windowListeners.message || []).forEach(fn=>fn({source:window,data}));
  const emit=(type,extra={})=>(listeners[type] || []).forEach(fn=>fn({type,target:video,...extra}));
  message({type:'LI_SET_BACKGROUND_PLAY',enabled:true});
  message({type:'LI_SET_AUTOPLAY_STATE',enabled:true});
  return {video,message,emit,messages,navigate:path=>{window.location.pathname=path;},foreground:()=>{hidden=false;},advance:()=>{now+=2000;},
    flush:async()=>{while(timers.length)await timers.shift()();}};
}
test('replacement player starts in background when canplay arrives',async()=>{
  const f=fixture(); f.emit('canplay'); await f.flush();
  assert.equal(f.video.calls,1);
});
test('Stop disables replacement player recovery',async()=>{
  const f=fixture();f.message({type:'LI_SET_AUTOPLAY_STATE',enabled:false});
  f.emit('canplay');await f.flush();assert.equal(f.video.calls,0);
});
test('foreground player is not started by background recovery',async()=>{
  const f=fixture();f.foreground();f.emit('canplay');await f.flush();assert.equal(f.video.calls,0);
});
test('trusted user pause remains paused after canplay',async()=>{
  const f=fixture();f.emit('pointerdown',{isTrusted:true});f.emit('pause');
  f.advance();f.emit('canplay');await f.flush();assert.equal(f.video.calls,0);
});
test('playing resets recovery attempts across repeated background pauses',async()=>{
  const f=fixture();
  for(let i=0;i<5;i++){
    f.video.paused=false;f.emit('playing');f.video.paused=true;f.emit('pause');await f.flush();
  }
  assert.equal(f.video.calls,5);
});

test('service-worker pulse retries a ready player even if canplay was missed',async()=>{
  const f=fixture(0);
  await f.flush();assert.equal(f.video.calls,0);
  f.video.readyState=4;
  f.message({type:'LI_BACKGROUND_PULSE'});await f.flush();
  assert.equal(f.video.calls,1);
});

test('background recovery cannot start an underlying video on a quiz route',async()=>{
  const f=fixture();f.navigate('/learning/course/quiz/one');f.emit('canplay');await f.flush();
  assert.equal(f.video.calls,0);
});
test('queued background play is cancelled when the route changes before its timer fires',async()=>{
  const f=fixture();f.navigate('/learning/course/next');await f.flush();assert.equal(f.video.calls,0);
});

test('Ctrl+Tab is not treated as a manual pause',async()=>{
  const f=fixture();f.emit('keydown',{isTrusted:true,key:'Tab',ctrlKey:true});
  f.emit('pause');await f.flush();assert.equal(f.video.calls,1);
});
test('an unrelated page click does not cancel background recovery',async()=>{
  const f=fixture();f.emit('pointerdown',{isTrusted:true,target:{tagName:'DIV'}});
  f.emit('pause');await f.flush();assert.equal(f.video.calls,1);
});
test('Space intentionally pauses and shares that intent with the content script',async()=>{
  const f=fixture();f.emit('keydown',{isTrusted:true,key:' '});
  f.emit('pause');await f.flush();
  assert.equal(f.video.calls,0);assert.equal(f.video.getAttribute('data-li-user-paused'),'true');
  f.emit('playing');assert.equal(f.video.getAttribute('data-li-user-paused'),null);
});
test('typing K in a text field does not cancel background recovery',async()=>{
  const f=fixture();f.emit('keydown',{isTrusted:true,key:'k',target:{tagName:'INPUT'}});
  f.emit('pause');await f.flush();assert.equal(f.video.calls,1);
});
test('a native play rejection requests the content fallback for the same route',async()=>{
  const f=fixture();f.video.play=async()=>{throw Object.assign(Error('blocked'),{name:'NotAllowedError'});};
  await f.flush();
  assert.deepEqual(f.messages.find(m=>m.type==='LI_BACKGROUND_PLAY_BLOCKED'),
    {type:'LI_BACKGROUND_PLAY_BLOCKED',path:'/learning/course/video'});
});
test('background pulses cannot overlap an unresolved play attempt',async()=>{
  const f=fixture();let release;
  f.video.play=()=>{f.video.calls++;return new Promise(resolve=>{release=resolve;});};
  const first=f.flush();await Promise.resolve();
  f.message({type:'LI_BACKGROUND_PULSE'});const second=f.flush();await second;
  assert.equal(f.video.calls,1);release();await first;
});
