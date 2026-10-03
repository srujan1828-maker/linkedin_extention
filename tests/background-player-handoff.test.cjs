const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','page-inject.js'),'utf8');
function fixture() {
  let hidden=true, now=10000;
  const listeners={}, windowListeners={}, timers=[];
  class Media {
    constructor(){this.tagName='VIDEO';this.paused=true;this.ended=false;this.isConnected=true;this.readyState=4;this.calls=0;this.rate=1;}
    get playbackRate(){return this.rate;}
    set playbackRate(v){this.rate=v;}
    addEventListener(){}
    async play(){this.calls++;this.paused=false;}
  }
  const video=new Media();
  const document=Object.create({get hidden(){return hidden;}});
  Object.assign(document,{hasFocus:()=>!hidden,querySelectorAll:()=>[video],querySelector:()=>video,
    addEventListener:(type,fn)=>(listeners[type] ||= []).push(fn)});
  const window={postMessage(){},addEventListener:(type,fn)=>(windowListeners[type] ||= []).push(fn)};
  new Function('window','document','HTMLMediaElement','setTimeout','setInterval','console','Date',source)(
    window,document,Media,fn=>timers.push(fn),()=>{}, {log(){},warn(){},error(){}},{now:()=>now});
  const message=data=>(windowListeners.message || []).forEach(fn=>fn({source:window,data}));
  const emit=(type,extra={})=>(listeners[type] || []).forEach(fn=>fn({target:video,...extra}));
  message({type:'LI_SET_BACKGROUND_PLAY',enabled:true});
  message({type:'LI_SET_AUTOPLAY_STATE',enabled:true});
  return {video,message,emit,foreground:()=>{hidden=false;},advance:()=>{now+=2000;},
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
