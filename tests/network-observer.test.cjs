const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {createLearningObserver} = require('../network-observer.js');
const origin = 'https://www.linkedin.com';
const route = '/learning/example/lesson';
const videoUrn = 'urn:li:video:test';
const quizUrn = 'urn:li:assessment:test';
const success = {data:{data:{doReportContentStateChangeClientReportedContentStateChangeActions:{result:{__typename:'restli_common_EmptyRecord'}}}}};
function fixture() {
  const events = [], location = {href:origin+route,pathname:route};
  const window = {};
  const observer = createLearningObserver({window,location,now:()=>1000,emit:e=>events.push(e)});
  const metadata = observer.classify('/learning-api/graphql?queryId=videos.hash','GET',route,100);
  observer.observe(metadata,null,{included:[{$type:'example.Video',entityUrn:videoUrn,slug:'lesson'}]},200);
  const progress = (body, status=200, response=success, atRoute=route) => observer.observe(
    observer.classify('/learning-api/graphql?queryId=clientReportedContentStateChangeActions.hash','POST',atRoute,200),
    {variables:{clientReportedStateChangeData:body}},response,status);
  return {events,location,window,observer,progress};
}
test('verified video progress emits only minimal completion metadata', () => {
  const f=fixture(); f.progress({contentUrn:videoUrn,currentClientProgressState:'COMPLETED',mediaTrackingId:'private'});
  assert.deepEqual(f.events,[{type:'LI_NETWORK_STATUS',kind:'video',status:'COMPLETED',path:route,startedAt:200,observedAt:1000}]);
});
test('HTTP and GraphQL failures never produce completion', () => {
  const f=fixture(); const state={contentUrn:videoUrn,currentClientProgressState:'COMPLETED'};
  f.progress(state,500); f.progress(state,200,{errors:[{message:'failed'}]}); f.progress(state,200,{});
  assert.deepEqual(f.events.map(e=>e.status),['FAILED','FAILED']);
});
test('late prior-video responses and unknown content cannot mark a new route complete', () => {
  const f=fixture(); f.location.pathname='/learning/example/next';
  f.progress({contentUrn:videoUrn,currentClientProgressState:'COMPLETED'},200,success,f.location.pathname);
  f.progress({contentUrn:'unknown',currentClientProgressState:'COMPLETED'});
  assert.equal(f.events.length,0);
});
test('quiz submission requires a matched identity and completed basic status with timestamp', () => {
  const f=fixture(); const meta=f.observer.classify('/learning-api/graphql?queryId=assessments.hash&variables='+encodeURIComponent('(key:'+quizUrn+')'),'GET',route,100);
  f.observer.observe(meta,null,{included:[{$type:'example.Assessment',entityUrn:quizUrn}]},200);
  const post=f.observer.classify('/learning-api/detailedAssessmentStatuses?action=submitResponse','POST',route,200);
  const response={included:[{$type:'example.ConsistentBasicAssessmentStatus',details:{statusType:'COMPLETED',completedAt:999}}]};
  f.observer.observe(post,{assessmentUrn:quizUrn,assessmentResponse:{optionIds:[123]}},response,200);
  assert.equal(f.events[0].status,'COMPLETED'); assert.equal(f.events[0].kind,'quiz');
  delete response.included[0].details.completedAt;
  f.observer.observe(post,{assessmentUrn:quizUrn},response,200);
  assert.equal(f.events.length,1);
});
test('reset and in-progress responses invalidate prior quiz completion', () => {
  const f=fixture(); const meta=f.observer.classify('/learning-api/graphql?queryId=assessments.hash&variables='+encodeURIComponent('(key:'+quizUrn+')'),'GET',route,100);
  f.observer.observe(meta,null,{included:[{$type:'example.Assessment',entityUrn:quizUrn}]},200);
  f.observer.observe(f.observer.classify('/learning-api/detailedAssessmentStatuses?action=reset','POST',route,200),
    {assessmentUrn:quizUrn},{included:[]},200);
  assert.equal(f.events[0].status,'IN_PROGRESS');
});
test('foreign origins and unrelated APIs are not observed', () => {
  const f=fixture();
  assert.equal(f.observer.classify('https://example.com/learning-api/detailedAssessmentStatuses','POST',route,0),null);
  assert.equal(f.observer.classify('/learning-api/cards?action=requestNextIncompleteLearningContainerItem','POST',route,0),null);
});
test('fetch hook preserves the original return value and makes no extra requests', async () => {
  const f=fixture(); let calls=0;
  const response={status:200,clone:()=>({text:async()=>JSON.stringify(success)})};
  const original=Promise.resolve(response);
  f.window.fetch=function(){calls++;return original;}; f.observer.install();
  const result=f.window.fetch('/learning-api/graphql?queryId=clientReportedContentStateChangeActions.hash',
    {method:'POST',body:JSON.stringify({variables:{clientReportedStateChangeData:{contentUrn:videoUrn,currentClientProgressState:'COMPLETED'}}})});
  assert.equal(result,original); await result; await new Promise(setImmediate);
  assert.equal(calls,1); assert.equal(f.events.length,1);
});
test('XHR hook preserves arguments and observes completion without consuming the response', async () => {
  const f=fixture(); let opened, sent;
  class XHR {open(...args){opened=args;} send(body){sent=body;} addEventListener(name,fn){this.listener=fn;}}
  f.window.XMLHttpRequest=XHR; f.observer.install(); const x=new XHR();
  x.open('POST','/learning-api/graphql?queryId=clientReportedContentStateChangeActions.hash',true);
  const body=JSON.stringify({variables:{clientReportedStateChangeData:{contentUrn:videoUrn,currentClientProgressState:'COMPLETED'}}});
  x.send(body); x.status=200;x.responseType='json';x.response=success;await x.listener();
  assert.equal(opened[2],true);assert.equal(sent,body);assert.equal(x.response,success);assert.equal(f.events.length,1);
});

function bridge() {
  const source=fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8');
  const start=source.indexOf('const networkCompletionSignals'),end=source.indexOf('async function verifyQuizGreenTick',start);
  let handler, clock=1000, resumed=0; const logs=[],timers=[];
  const window={location:{origin,pathname:route},addEventListener:(name,fn)=>{handler=fn;}};
  const ctx=vm.createContext({window,Date:{now:()=>clock},quizAutoPaused:false,isDiscoveringPathQueue:false,isBulkActive:true,
    setTimeout:fn=>timers.push(fn),runAutonomousStep:()=>{resumed++;},checkAndAutoSolveQuiz:()=>{},addLog:m=>logs.push(m)});
  vm.runInContext(source.slice(start,end),ctx);
  const event=(status='COMPLETED',extra={})=>handler({source:window,origin,data:{type:'LI_NETWORK_STATUS',kind:'quiz',status,path:route,startedAt:1000,observedAt:1000,...extra}});
  return {ctx,event,window,timers,logs,setClock:v=>{clock=v;},resumed:()=>resumed,has:()=>vm.runInContext("hasNetworkCompletion(window.location.pathname,'quiz')",ctx)};
}
test('completion bridge nudges the runner and reset removes evidence', () => {
  const f=bridge();f.event();assert.equal(f.has(),true);f.timers[0]();assert.equal(f.resumed(),1);
  f.event('IN_PROGRESS');assert.equal(f.has(),false);
});
test('bridge rejects another route, stale evidence and responses predating a new run', () => {
  const f=bridge();f.event('COMPLETED',{path:'/learning/example/other'});assert.equal(f.has(),false);
  f.setClock(2000);vm.runInContext('resetNetworkCompletionSignals()',f.ctx);f.event();assert.equal(f.has(),false);
  f.setClock(130000);f.event('COMPLETED',{startedAt:2000,observedAt:2000});assert.equal(f.has(),false);
});
test('Stop cancels scheduled continuation and ignores new completion messages', () => {
  const f=bridge();f.event();vm.runInContext('quizAutoPaused=true; resetNetworkCompletionSignals()',f.ctx);
  f.timers[0]();f.event();assert.equal(f.has(),false);assert.equal(f.resumed(),0);
});
test('failed progress is logged without retrying or marking completion', () => {
  const f=bridge();f.setClock(40000);f.event('FAILED',{startedAt:40000,observedAt:40000});
  assert.equal(f.has(),false);assert.equal(f.resumed(),0);assert.equal(f.logs.length,1);
});

test('multiple quiz status records cannot falsely complete the submitted quiz',()=>{
 const f=fixture();
 const meta=f.observer.classify('/learning-api/graphql?queryId=assessments.hash&variables='+encodeURIComponent('(key:'+quizUrn+')'),'GET',route,100);
 f.observer.observe(meta,null,{included:[{$type:'example.Assessment',entityUrn:quizUrn}]},200);
 const post=f.observer.classify('/learning-api/detailedAssessmentStatuses?action=submitResponse','POST',route,200);
 f.observer.observe(post,{assessmentUrn:quizUrn},{included:[
  {$type:'example.ConsistentBasicAssessmentStatus',details:{statusType:'COMPLETED',completedAt:999}},
  {$type:'example.ConsistentBasicAssessmentStatus',details:{statusType:'IN_PROGRESS'}}
 ]},200);
 assert.equal(f.events.length,0);
});
