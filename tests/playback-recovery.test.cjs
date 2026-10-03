const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const helper = source.slice(source.indexOf('function createPlaybackRecovery('), source.indexOf('let playbackRecovery;'));
const create = new Function(helper + ';return createPlaybackRecovery;')();
function fixture() {
  const values = {};
  const storage = {getItem:k=>values[k] || null, setItem:(k,v)=>{values[k]=v;}};
  return {storage, runner:create(storage)};
}
const input = (now, extra={}) => ({path:'/learning/course/video',now,active:true,videoExpected:true,...extra});
test('missing video reloads at one minute, never after 1.5 seconds', () => {
  const {runner} = fixture();
  assert.equal(runner.step(input(0)), null);
  assert.equal(runner.step(input(1500)), null);
  assert.equal(runner.step(input(59999)), null);
  assert.equal(runner.step(input(60000)), 'reload');
});
test('buffering despite an unpaused player triggers recovery', () => {
  const {runner} = fixture();
  runner.step(input(0,{videoTime:4}));
  assert.equal(runner.step(input(60000,{videoTime:4})), 'reload');
});
test('real playback progress resets the stall clock', () => {
  const {runner} = fixture();
  runner.step(input(0,{videoTime:4}));
  assert.equal(runner.step(input(59000,{videoTime:5})), null);
  assert.equal(runner.step(input(60000,{videoTime:5})), null);
  assert.equal(runner.step(input(119000,{videoTime:5})), 'reload');
});
test('reload budget survives document recreation and stops refresh loops', () => {
  const {storage,runner} = fixture();
  runner.step(input(0)); assert.equal(runner.step(input(60000)), 'reload');
  const second = create(storage);
  second.step(input(61000)); assert.equal(second.step(input(121000)), 'reload');
  const third = create(storage);
  third.step(input(122000)); assert.equal(third.step(input(182000)), 'pause');
});
test('Try again is throttled and limited to three clicks before reload', () => {
  const {runner} = fixture();
  const error = now=>input(now,{errorPage:true,retryAvailable:true});
  assert.equal(runner.step(error(0)), 'retry');
  assert.equal(runner.step(error(500)), null);
  assert.equal(runner.step(error(15000)), 'retry');
  assert.equal(runner.step(error(30000)), 'retry');
  assert.equal(runner.step(error(45000)), null);
  assert.equal(runner.step(error(60000)), 'reload');
});
test('quiz questions and path overviews are not reloaded', () => {
  const {runner} = fixture();
  runner.step(input(0,{quiz:true}));
  assert.equal(runner.step(input(120000,{quiz:true})), null);
  assert.equal(runner.step(input(240000,{videoExpected:false})), null);
});
test('Stop disarms recovery and changing lessons gives a fresh minute', () => {
  const {runner} = fixture();
  runner.step(input(0));
  assert.equal(runner.step(input(60000,{active:false})), null);
  assert.equal(runner.step(input(61000)), null);
  assert.equal(runner.step(input(120000,{path:'/learning/course/next'})), null);
});
test('blocked session storage does not throw', () => {
  const runner=create({getItem(){throw Error('denied');},setItem(){throw Error('denied');}});
  runner.step(input(0)); assert.equal(runner.step(input(60000)), 'reload');
});
test('singular quiz result and Continue watching are detected', () => {
  const begin=source.indexOf('function getQuizResultState()');
  const end=source.indexOf('function hasActiveQuizQuestion()',begin);
  const button={innerText:'Continue watching'};
  const root={innerText:'You answered 1 of 1 question correctly. You successfully completed all questions in this quiz.',querySelectorAll:()=>[button]};
  const document={querySelector:()=>root,body:root};
  const detect=new Function('document','isInsideSidebar','isElementClickable',source.slice(begin,end)+';return getQuizResultState;')(document,()=>false,()=>true);
  assert.equal(detect().visible,true); assert.equal(detect().passed,true);
});
test('scored practice results still require completion verification', () => {
  const begin=source.indexOf('function getQuizResultState()');
  const end=source.indexOf('function hasActiveQuizQuestion()',begin);
  const root={innerText:'You answered 0 of 1 question correctly. Keep practicing!',querySelectorAll:()=>[{innerText:'Continue watching'}]};
  const detect=new Function('document','isInsideSidebar','isElementClickable',source.slice(begin,end)+';return getQuizResultState;')({querySelector:()=>root,body:root},()=>false,()=>true);
  assert.equal(detect().visible,true); assert.equal(detect().passed,false);
});

function continuationFixture(syllabus=[]) {
  let now=10000, clicks=0, destination=null;
  const quizPath='/learning/course/quiz/one';
  const begin=source.indexOf('async function continueAfterQuiz(');
  const end=source.indexOf('async function solveLinkedInQuizWithGreenTickRetry(',begin);
  const globals={
    Date:{now:()=>now}, window:{location:{pathname:quizPath}},
    chrome:{storage:{local:{get:async()=>({})}}},
    expandAllSections:()=>{}, getCourseSyllabus:()=>syllabus,
    navigateToLesson:lesson=>{destination=lesson.href;return true;},
    getQuizResultState:()=>({root:{querySelectorAll:()=>[{innerText:'Continue watching',click:()=>{clicks++;}}]}}),
    isElementClickable:()=>true
  };
  const prelude="let quizRunEpoch=0, quizAutoPaused=false, autoNavigateEnabled=true, isDiscoveringPathQueue=false, isBulkActive=true, autoplayEnabled=true, quizContinuationInFlight=false, lastQuizContinuationPath='', lastQuizContinuationAt=0, focusMode='pending_only'; const continuedQuizUrls=new Set();";
  const run=new Function(...Object.keys(globals),prelude+source.slice(begin,end)+';return continueAfterQuiz;')(...Object.values(globals));
  return {run,quizPath,advance:()=>{now+=3000;},clicks:()=>clicks,destination:()=>destination};
}
test('Continue watching is retried after cooldown if the route did not change',async()=>{
  const f=continuationFixture();
  assert.equal(await f.run(f.quizPath),true);
  assert.equal(f.clicks(),1);
  assert.equal(await f.run(f.quizPath),false);
  f.advance();
  assert.equal(await f.run(f.quizPath),true);
  assert.equal(f.clicks(),2);
});
test('quiz continuation returns to a missed video before advancing forward',async()=>{
  const f=continuationFixture([
    {href:'/learning/course/missed',isVideo:true,completed:false},
    {href:'/learning/course/quiz/one',isQuiz:true,completed:true},
    {href:'/learning/course/next',isVideo:true,completed:false}
  ]);
  assert.equal(await f.run(f.quizPath),true);
  assert.equal(f.destination(),'/learning/course/missed');
});
