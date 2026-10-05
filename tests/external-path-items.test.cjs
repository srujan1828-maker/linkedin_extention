const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','content.js'),'utf8');
const snippet=source.slice(source.indexOf('function getExternalPathItemState()'),source.indexOf('function findBackToLearningPathButton()'));
function fixture({completed=false,dialog=false,mark=true,open=true,back=true,video=false,quiz=false,bulk=true,autoplay=true,hidden=false,bg=true,navigate=true,stopped=false,next=true,foreignDialog=false,skip=true,mode='pending_only'}={}){
 let confirmations=0,markClicks=0,nextClicks=0,returns=0,timerCleared=0,now=10000;
 const control=(text,click=()=>{})=>({innerText:text,isConnected:true,getAttribute:()=>'',click});
 const confirm=control('Mark as complete',()=>{confirmations++;});
 const modal={innerText:foreignDialog?'Mark as complete this purchase':'Mark as complete\nHave you completed this article?\nRemember to mark as complete to finish.',querySelector:()=>({innerText:'Mark as complete'}),querySelectorAll:()=>[control('Not yet'),confirm]};
 const controls=[...(open?[control('Open link')]:[]),...(back?[control('BACK TO LEARNING PATH · Gender Equity and Empowerment')]:[]),...(mark?[control('Mark as complete',()=>{markClicks++;})]:[]),...(next?[control('Next in this Learning Path →',()=>{nextClicks++;})]:[])];
 const status=[];if(completed)status.push({innerText:'Completed 10/4/2026'});
 const root={querySelectorAll:selector=>selector==='button, a, [role="button"]'?controls:status};
 const document={body:root,hidden,querySelector:selector=>(selector==='video'&&video)||(selector.includes('.chapter-quiz')&&quiz)?{}:null,querySelectorAll:()=>dialog?[modal]:[]};
 const ctx=vm.createContext({document,window:{location:{pathname:'/learning-career-hub/content/article'}},
 isLearningPathPage:()=>false,isQuizOnPage:()=>quiz,isElementClickable:()=>true,
 nonVideoTimer:42,clearTimeout:()=>{timerCleared++;},quizAutoPaused:stopped,isDiscoveringPathQueue:false,
 isBulkActive:bulk,skipNonVideos:skip,focusMode:mode,autoplayEnabled:autoplay,autoNavigateEnabled:navigate,backgroundRun:bg,quizRunEpoch:0,Date:{now:()=>now},
 clickElement:el=>el.click(),showHUD:()=>{},sendProgress:()=>{},addLog:()=>{},returnToLearningPath:async()=>{returns++;return false;}});
 vm.runInContext(snippet,ctx);
 return {ctx,controls,status,confirm,advance:()=>{now+=3000;},run:()=>vm.runInContext('handleExternalPathItem()',ctx),state:()=>vm.runInContext('getExternalPathItemState()',ctx),counts:()=>({confirmations,markClicks,nextClicks,returns,timerCleared})};
}
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('external article is detected without a video or TOC',()=>{const f=fixture();assert.ok(f.state());assert.equal(f.run(),true);assert.equal(f.counts().timerCleared,1);assert.equal(f.counts().returns,0);});
test('AutoPilot clicks the first completion button but waits before navigating',async()=>{const f=fixture();f.run();f.run();await drain();assert.equal(f.counts().markClicks,1);assert.equal(f.counts().confirmations,0);assert.equal(f.counts().nextClicks,0);assert.equal(f.counts().returns,0);});
test('article confirmation dialog is completed once and navigation waits for recorded status',async()=>{const f=fixture({dialog:true});f.run();f.run();await drain();assert.equal(f.counts().confirmations,1);assert.equal(f.counts().returns,0);});
test('recorded Completed date returns to the path and falls back to Next',async()=>{const f=fixture({completed:true,mark:false});f.run();f.run();await drain();assert.equal(f.counts().returns,1);assert.equal(f.counts().nextClicks,1);});
test('ordinary autoplay can continue a completed external item',async()=>{const f=fixture({completed:true,mark:false,bulk:false});f.run();await drain();assert.equal(f.counts().nextClicks,1);});
test('an open dialog is not treated as a saved completion status',async()=>{const f=fixture({completed:true,dialog:true});f.run();await drain();assert.equal(f.counts().returns,0);});
test('Stop, disabled automation/navigation, and hidden foreground-only mode do not act',async()=>{for(const opts of [{stopped:true},{bulk:false,autoplay:false},{navigate:false},{hidden:true,bg:false}]){const f=fixture({...opts,dialog:true,completed:true});f.run();await drain();assert.equal(f.counts().confirmations,0);assert.equal(f.counts().returns,0);}});
test('course videos, quiz pages, and unrelated completion dialogs are excluded',()=>{for(const opts of [{video:true},{quiz:true},{back:false},{open:false}]){const f=fixture(opts);assert.equal(f.state(),null);}const f=fixture({dialog:true,foreignDialog:true});f.run();assert.equal(f.counts().confirmations,0);});
test('completion text must be a dated standalone status, not a description',()=>{const f=fixture({mark:false});f.status.push({innerText:'Learn how to mark an article Completed 10/4/2026'});assert.equal(f.state(),null);});
test('Stop during path lookup cancels the Next fallback',async()=>{const f=fixture({completed:true});let release;f.ctx.returnToLearningPath=()=>new Promise(resolve=>{release=resolve;});f.run();f.ctx.quizRunEpoch++;f.ctx.quizAutoPaused=true;release(false);await drain();assert.equal(f.counts().nextClicks,0);});
test('route change during path lookup cancels stale Next action',async()=>{const f=fixture({completed:true});let release;f.ctx.returnToLearningPath=()=>new Promise(resolve=>{release=resolve;});f.run();f.ctx.window.location.pathname='/learning/course/new';release(false);await drain();assert.equal(f.counts().nextClicks,0);});
test('no path destination leaves a completed article stable instead of retrying forever',async()=>{const f=fixture({completed:true,next:false});f.run();await drain();f.run();await drain();assert.equal(f.counts().returns,1);});
const statusSource=source.slice(source.indexOf('function isPathItemCompleted('),source.indexOf('/**\n * Extracts course/video items',source.indexOf('function isPathItemCompleted(')));
const completedCard=new Function(statusSource+';return isPathItemCompleted;')();
test('dated Visited status counts for external links only',()=>{const card={innerText:'Link\nGender Emerging Issues\nVisited 10/4/2026'};assert.equal(completedCard(card,'external'),true);assert.equal(completedCard(card,'video'),false);assert.equal(completedCard(card,'course'),false);});
test('undated visited wording and incomplete link status are not completion',()=>{for(const text of ['Link\nVisited places','Link\nVisited','Link\nNot completed\nVisited 10/4/2026'])assert.equal(completedCard({innerText:text},'external'),false);});
const getItemsSource=source.slice(source.indexOf('function getLearningPathItems()'),source.indexOf('// External path items have no player'));
test('Link type takes precedence over standalone query and career hub wrappers are accepted',()=>{const link={getAttribute:()=>'/learning-career-hub/content/article?standalone=true',textContent:'Article'};const card={innerText:'Link\nArticle\nVisited 10/4/2026',querySelector:selector=>selector.includes('h3')?link:{innerText:'Link'}};const globals={document:{querySelectorAll:()=>[card]},window:{location:{href:'https://www.linkedin.com/learning/paths/test',origin:'https://www.linkedin.com'}},URL,isPathItemCompleted:completedCard};const getItems=new Function(...Object.keys(globals),getItemsSource+';return getLearningPathItems;')(...Object.values(globals));assert.equal(getItems()[0].type,'external');assert.equal(getItems()[0].completed,true);});

test('initial Mark as complete retries are limited and spaced three seconds apart',()=>{const f=fixture();for(let i=0;i<10;i++){f.run();f.run();f.advance();}assert.equal(f.counts().markClicks,3);});
test('ordinary autoplay, disabled non-video handling, and video/quiz focus do not auto-mark',()=>{for(const opts of [{bulk:false},{skip:false},{mode:'videos_only'},{mode:'quizzes_only'}]){const f=fixture(opts);f.run();assert.equal(f.counts().markClicks,0);}});
test('Stop disables the first Mark as complete click',()=>{const f=fixture({stopped:true});f.run();assert.equal(f.counts().markClicks,0);});
test('an open confirmation dialog does not click the underlying initial button',()=>{const f=fixture({dialog:true});f.run();assert.equal(f.counts().markClicks,0);assert.equal(f.counts().confirmations,1);});

test('Career Hub article wrapper is recognized even when the legacy quiz heuristic says true',()=>{const f=fixture();f.ctx.isQuizOnPage=()=>true;assert.ok(f.state());f.run();assert.equal(f.counts().markClicks,1);});
test('dedicated quiz URLs never trigger the article completion action',()=>{const f=fixture();f.ctx.window.location.pathname='/career-hub/assessment/example';assert.equal(f.state(),null);});

test('ordinary external Career Hub articles are not sent to the quiz solver',()=>{const f=fixture({bulk:false});Object.assign(f.ctx,{window:{location:{pathname:'/career-hub/content/article',href:'https://www.linkedin.com/career-hub/content/article'}},quizErrorUrl:null,quizError:null,isSolvingQuiz:false,isQuizWorkflowRunning:false,autoSolveQuizzes:true});f.ctx.isQuizOnPage=()=>true;const start=source.indexOf('function checkAndAutoSolveQuiz()');const end=source.indexOf('// ─── Autonomous Bulk Video Completer',start);vm.runInContext(source.slice(start,end),f.ctx);assert.doesNotThrow(()=>vm.runInContext('checkAndAutoSolveQuiz()',f.ctx));});
