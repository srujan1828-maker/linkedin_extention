const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8');
const start=source.indexOf('function findEarlierUnfinishedLesson(');
const end=source.indexOf('async function runAutonomousStep()',start);
const earlier=new Function(source.slice(start,end)+';return findEarlierUnfinishedLesson;')();
const syllabus=[
 {href:'/learning/course/one',isVideo:true,completed:true},
 {href:'/learning/course/quiz/one',isQuiz:true,completed:false},
 {href:'/learning/course/two',isVideo:true,completed:false}
];
test('native autoplay past an unfinished quiz returns to that quiz',()=>{
 assert.equal(earlier(syllabus,syllabus[2].href).href,syllabus[1].href);
});
test('videos-only mode intentionally leaves chapter quizzes alone',()=>{
 assert.equal(earlier(syllabus,syllabus[2].href,'videos_only'),null);
});
test('completed quizzes are never revisited',()=>{
 assert.equal(earlier(syllabus.map(x=>({...x,completed:true})),syllabus[2].href),null);
});
test('unknown routes do not redirect to an unrelated lesson',()=>{
 assert.equal(earlier(syllabus,'/learning/course/unknown'),null);
});
test('an earlier unfinished video is recovered in course order',()=>{
 const items=syllabus.map((x,i)=>({...x,completed:i===0?false:x.completed}));
 assert.equal(earlier(items,items[2].href).href,items[0].href);
});
function watchdogFixture({lastRun=10000,rate=1,locked=false,quiz=false}={}) {
 let runs=0,speedUpdates=0;
 const video={paused:false,ended:false,playbackRate:rate};
 const globals={
 isExtensionContextActive:()=>true,recoverPendingLessonNavigation:()=>{},syncBackgroundSupervision:()=>{},handleExternalPathItem:()=>false,recoverBlockedPlayback:()=>false,document:{querySelector:()=>video},
 videoEl:video,attachToVideo:()=>{},isDiscoveringPathQueue:false,
 isBulkActive:true,isQuizOnPage:()=>quiz,speedInjectionEnabled:true,currentSpeed:16,
 lastRateChangeTime:0,Date:{now:()=>20000},applySpeed:()=>{speedUpdates++;},
 requestManagedPlayback:()=>{},dismissSurveyIfPresent:()=>false,
 isRunningAutonomousStep:locked,isNavigatingToLesson:false,isSolvingQuiz:false,isQuizWorkflowRunning:false,
 isGlobalNavPage:()=>false,isLearningPathPage:()=>false,lastStepRunTime:lastRun,runAutonomousStep:()=>{runs++;}
 };
 const begin=source.indexOf('function runPlaybackWatchdog()'),end=source.indexOf('// ─── Video Attachment',begin);
 const run=new Function(...Object.keys(globals),source.slice(begin,end)+';return runPlaybackWatchdog;')(...Object.values(globals));
 return {run,runs:()=>runs,speedUpdates:()=>speedUpdates};
}
test('playing video still triggers periodic syllabus reconciliation',()=>{
 const f=watchdogFixture();f.run();assert.equal(f.runs(),1);
});
test('bulk background watchdog restores a reset playback rate',()=>{
 const f=watchdogFixture({locked:true});f.run();assert.equal(f.speedUpdates(),1);
});
test('reconciliation is throttled rather than run every watchdog tick',()=>{
 const f=watchdogFixture({lastRun:19900,rate:16});f.run();assert.equal(f.runs(),0);assert.equal(f.speedUpdates(),0);
});
test('workflow locks do not start a second autonomous step',()=>{
 const f=watchdogFixture({locked:true});f.run();assert.equal(f.runs(),0);
});

test('content playback request refuses an underlying video while a quiz is open',()=>{
 const begin=source.indexOf('function requestManagedPlayback('),end=source.indexOf('let recoveryReloadInFlight',begin);
 const globals={quizRunEpoch:0,window:{location:{pathname:'/learning/course/lesson'}},quizAutoPaused:false,isDiscoveringPathQueue:false,
 isBulkActive:true,autoplayEnabled:true,backgroundRun:true,document:{hidden:false},
 isQuizOnPage:()=>true,isLearningPathPage:()=>false,managedPlayback:(video,allowed)=>allowed()};
 const request=new Function(...Object.keys(globals),source.slice(begin,end)+';return requestManagedPlayback;')(...Object.values(globals));
 assert.equal(request({isConnected:true}),false);
});
test('content playback request refuses preview videos on path overviews',()=>{
 const begin=source.indexOf('function requestManagedPlayback('),end=source.indexOf('let recoveryReloadInFlight',begin);
 const globals={quizRunEpoch:0,window:{location:{pathname:'/learning/paths/course'}},quizAutoPaused:false,isDiscoveringPathQueue:false,
 isBulkActive:true,autoplayEnabled:true,backgroundRun:true,document:{hidden:false},
 isQuizOnPage:()=>false,isLearningPathPage:()=>true,managedPlayback:(video,allowed)=>allowed()};
 const request=new Function(...Object.keys(globals),source.slice(begin,end)+';return requestManagedPlayback;')(...Object.values(globals));
 assert.equal(request({isConnected:true}),false);
});
