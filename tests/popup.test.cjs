const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','popup.js'),'utf8');
async function findTab(raw) {
 const begin=source.indexOf('async function getActiveLinkedInTab()');
 const end=source.indexOf('async function sendToContent',begin);
 return vm.runInNewContext(source.slice(begin,end)+';getActiveLinkedInTab()',{
 URL,chrome:{tabs:{query:async()=>[{id:1,url:raw}]}}
 });
}
test('popup accepts only the LinkedIn learning origin and routes',async()=>{
 assert.equal((await findTab('https://www.linkedin.com/learning/course/video')).id,1);
 for(const url of ['https://linkedin.com.evil.example/learning/course','https://www.linkedin.com/feed/',
 'https://other.example/?next=linkedin.com','http://www.linkedin.com/learning/course']){
  assert.equal(await findTab(url),null);
 }
});
test('popup Stop clears queued discovery even without a responding learning tab',async()=>{
 let ready,stop;const saved={bulkActive:true,pathQueueDiscoveryActive:true,pathQueueActive:true};
 const button={addEventListener:(type,handler)=>{stop=handler;}};
 const document={getElementById:id=>id==='btn-stop-bulk'?button:null,querySelectorAll:()=>[],querySelector:()=>null,
 addEventListener:(type,handler)=>{if(type==='DOMContentLoaded')ready=handler;}};
 const chrome={
 runtime:{getManifest:()=>({version:'test'}),onMessage:{addListener:()=>{}}},
 tabs:{query:async()=>[{id:1,url:'https://www.linkedin.com/feed/'}]},
 storage:{onChanged:{addListener:()=>{}},local:{get:(keys,reply)=>{if(reply)reply(saved);else return Promise.resolve(saved);},set:async values=>Object.assign(saved,values)}}
 };
 vm.runInNewContext(source,{document,chrome,URL,console,setInterval:()=>{},setTimeout:()=>{}});
 ready();await stop();
 assert.equal(saved.bulkActive,false);assert.equal(saved.pathQueueDiscoveryActive,false);
 assert.equal(saved.pathQueueActive,false);assert.equal(saved.pathQueueDiscovery,null);
});
