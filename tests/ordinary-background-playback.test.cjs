const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8');
function watchdog({enabled=true,bg=true,manual=false,stopped=false,quiz=false}={}) {
 let plays=0;
 const video={paused:true,ended:false,readyState:4,currentTime:0,getAttribute:()=>manual?'true':null};
 const globals={
 isExtensionContextActive:()=>true,recoverPendingLessonNavigation:()=>{},syncBackgroundSupervision:()=>{},
 handleExternalPathItem:()=>false,recoverBlockedPlayback:()=>false,document:{hidden:true,querySelector:()=>video},videoEl:video,
 attachToVideo:()=>{},isDiscoveringPathQueue:false,isBulkActive:false,isQuizOnPage:()=>quiz,
 dismissSurveyIfPresent:()=>false,checkAndAutoSolveQuiz:()=>{},nonVideoTimer:null,
 speedInjectionEnabled:false,currentSpeed:16,lastRecordedTime:0,stuckCount:0,
 autoplayEnabled:enabled,quizAutoPaused:stopped,backgroundRun:bg,requestManagedPlayback:()=>{plays++;}
 };
 const start=source.indexOf('function runPlaybackWatchdog()'),end=source.indexOf('// ─── Video Attachment',start);
 const run=new Function(...Object.keys(globals),source.slice(start,end)+';return runPlaybackWatchdog;')(...Object.values(globals));
 return {run,plays:()=>plays};
}
test('ordinary autoplay resumes a paused ready video in a hidden tab',()=>{
 const f=watchdog();f.run();assert.equal(f.plays(),1);
});
test('disabled ordinary autoplay does not restart a paused video',()=>{
 const f=watchdog({enabled:false});f.run();assert.equal(f.plays(),0);
});
test('background playback off preserves hidden-tab pause',()=>{
 const f=watchdog({bg:false});f.run();assert.equal(f.plays(),0);
});
test('intentional user pause is respected by ordinary autoplay',()=>{
 const f=watchdog({manual:true});f.run();assert.equal(f.plays(),0);
});
test('Stop and quiz routes do not resume ordinary playback',()=>{
 for(const options of [{stopped:true},{quiz:true}]){const f=watchdog(options);f.run();assert.equal(f.plays(),0);}
});
test('content managed playback refuses the shared intentional-pause marker',()=>{
 const start=source.indexOf('function requestManagedPlayback('),end=source.indexOf('let recoveryReloadInFlight',start);
 const globals={quizRunEpoch:0,window:{location:{pathname:'/learning/course/video'}},quizAutoPaused:false,
 isDiscoveringPathQueue:false,isBulkActive:true,autoplayEnabled:true,backgroundRun:true,document:{hidden:true},
 isQuizOnPage:()=>false,isLearningPathPage:()=>false,managedPlayback:(v,allowed)=>allowed()};
 const request=new Function(...Object.keys(globals),source.slice(start,end)+';return requestManagedPlayback;')(...Object.values(globals));
 assert.equal(request({isConnected:true,getAttribute:()=> 'true'}),false);
});
test('blocked MAIN playback is handed to managed fallback only for the current origin and route',()=>{
 const start=source.indexOf("window.addEventListener('message', event => {",source.indexOf('// ─── Playback Engine'));
 const end=source.indexOf('function syncPlaybackSettings()',start);
 assert.ok(start>=0 && end>start);
 let callback,requests=0;
 const video={};
 const window={location:{origin:'https://www.linkedin.com',pathname:'/learning/course/video'},addEventListener:(type,fn)=>{callback=fn;}};
 new Function('window','document','backgroundRun','requestManagedPlayback',source.slice(start,end))(
 window,{querySelector:()=>video},true,v=>{assert.equal(v,video);requests++;});
 const event={source:window,origin:window.location.origin,data:{type:'LI_BACKGROUND_PLAY_BLOCKED',path:window.location.pathname}};
 callback(event);assert.equal(requests,1);
 callback({...event,origin:'https://example.com'});callback({...event,data:{...event.data,path:'/learning/course/old'}});
 assert.equal(requests,1);
});
