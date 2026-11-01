import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDesktopPlatform} from '../dist/desktop/platform.js';
import {executeDesktopTool} from '../dist/desktop/adapter.js';
import {toolInputSchemas} from '@deskbeacon/protocol';

test('native desktop platforms have explicit compatibility boundaries',()=>{
  for(const [os,arch] of [['win32','x64'],['win32','arm64'],['darwin','x64'],['darwin','arm64']]){
    assert.equal(checkDesktopPlatform(os,arch,{}).supported,true);
  }
  assert.equal(checkDesktopPlatform('android','arm64',{}).supported,false);
  assert.equal(checkDesktopPlatform('linux','x64',{PREFIX:'/data/data/com.termux/files/usr'},'2.39').supported,false);
  assert.equal(checkDesktopPlatform('linux','x64',{},'2.34').supported,false);
  assert.equal(checkDesktopPlatform('linux','x64',{},'').supported,false);
  assert.equal(checkDesktopPlatform('linux','x64',{},'2.35').supported,true);
  assert.equal(checkDesktopPlatform('freebsd','x64',{}).supported,false);
  assert.equal(checkDesktopPlatform('win32','ia32',{}).supported,false);
});

test('desktop tool schemas validate target refs and mode without accepting arbitrary fields',()=>{
  const input={deviceId:'device',refId:'@s123abc:e5'};
  assert.equal(toolInputSchemas.desktop_click.safeParse(input).success,true);
  assert.equal(toolInputSchemas.desktop_click.safeParse({...input,refId:'@e5'}).success,false);
  assert.equal(toolInputSchemas.desktop_click.safeParse({...input,interactionMode:'unsupported'}).success,false);
  assert.equal(toolInputSchemas.desktop_snapshot.safeParse({deviceId:'device',rootRef:'@s123abc:e5',surface:'menu'}).success,false);
  assert.equal(toolInputSchemas.desktop_input.safeParse({...input,action:'type'}).success,false);
  assert.equal(toolInputSchemas.desktop_input.safeParse({...input,action:'clear',text:'secret'}).success,false);
});

test('desktop defaults allow headed operations and display cursors while respecting explicit overrides',async()=>{
  const {DEFAULT_DESKTOP_MODE,DEFAULT_DESKTOP_CURSOR,normalizeDesktopMode,normalizeDesktopCursor}=
    await import('../dist/desktop/defaults.js');
  const {requireDesktopPermission,desktopPolicy}=await import('../dist/desktop/policy.js');
  assert.equal(DEFAULT_DESKTOP_MODE,'headed_allowed');
  assert.equal(DEFAULT_DESKTOP_CURSOR,true);
  assert.equal(normalizeDesktopMode(undefined),'headed_allowed');
  assert.equal(normalizeDesktopCursor(undefined),true);
  assert.equal(normalizeDesktopMode('headless_only'),'headless_only');
  assert.equal(normalizeDesktopMode('observe_only'),'observe_only');
  assert.equal(normalizeDesktopCursor(false),false);
  assert.doesNotThrow(()=>requireDesktopPermission('desktop_click',{interactionMode:'headed'},
    {mode:DEFAULT_DESKTOP_MODE,cursor:DEFAULT_DESKTOP_CURSOR}));
  assert.throws(()=>requireDesktopPermission('desktop_click',{interactionMode:'headed'},
    {mode:'headless_only',cursor:false}),e=>e.code==='DESKTOP_POLICY_DENIED');
  const effective=desktopPolicy();
  assert.ok(['headed_allowed','headless_only','observe_only'].includes(effective.mode));
});

test('all fourteen Desktop tools are registered with bounded, action-specific inputs',()=>{
 const names=['desktop_status','desktop_list','desktop_snapshot','desktop_find','desktop_get',
 'desktop_click','desktop_input','desktop_wait','desktop_control','desktop_press',
 'desktop_pointer','desktop_app','desktop_window','desktop_session'];
 for(const name of names)assert.ok(name in toolInputSchemas,name);
 const deviceId='device';
 assert.equal(toolInputSchemas.desktop_control.safeParse({deviceId,refId:'@s123:e1',action:'select'}).success,false);
 assert.equal(toolInputSchemas.desktop_control.safeParse({deviceId,refId:'@s123:e1',action:'check',value:'secret'}).success,false);
 assert.equal(toolInputSchemas.desktop_press.safeParse({deviceId,key:'ctrl+s'}).success,false);
 assert.equal(toolInputSchemas.desktop_press.safeParse({deviceId,key:'ctrl+s',interactionMode:'headed'}).success,true);
 assert.equal(toolInputSchemas.desktop_pointer.safeParse({deviceId,action:'click',interactionMode:'headed'}).success,false);
 assert.equal(toolInputSchemas.desktop_pointer.safeParse({deviceId,action:'click',x:20,y:30,interactionMode:'headed'}).success,true);
 assert.equal(toolInputSchemas.desktop_app.safeParse({deviceId,action:'launch',app:'Notepad.exe',activate:true}).success,false);
 assert.equal(toolInputSchemas.desktop_app.safeParse({deviceId,action:'launch',app:'Notepad.exe',activate:true,interactionMode:'headed'}).success,true);
 assert.equal(toolInputSchemas.desktop_window.safeParse({deviceId,action:'focus',windowId:'w-1'}).success,false);
 assert.equal(toolInputSchemas.desktop_window.safeParse({deviceId,action:'focus',windowId:'w-1',interactionMode:'headed'}).success,true);
 assert.equal(toolInputSchemas.desktop_session.safeParse({deviceId,action:'end'}).success,false);
 assert.equal(toolInputSchemas.desktop_session.safeParse({deviceId,action:'start',multiAgent:true}).success,false);
 assert.equal(toolInputSchemas.screen_capture.safeParse({deviceId,monitor:0}).success,true);
 assert.equal(toolInputSchemas.screen_capture.safeParse({deviceId,target:'window'}).success,false);
 assert.equal(toolInputSchemas.screen_capture.safeParse({deviceId,target:'window',windowId:'w-1'}).success,true);
 assert.equal(toolInputSchemas.screen_capture.safeParse({deviceId,target:'app',app:'Notepad.exe'}).success,true);
});

test('device-local policy rejects forbidden desktop actions before invoking native code',async()=>{
 const {requireDesktopPermission}=await import('../dist/desktop/policy.js');
 const observe={mode:'observe_only',cursor:false};
 const headless={mode:'headless_only',cursor:false};
 const headed={mode:'headed_allowed',cursor:false};
 assert.doesNotThrow(()=>requireDesktopPermission('desktop_snapshot',{},observe));
 assert.throws(()=>requireDesktopPermission('desktop_click',{refId:'@s123:e1'},observe),
   e=>e.code==='DESKTOP_POLICY_DENIED');
 assert.doesNotThrow(()=>requireDesktopPermission('desktop_click',{refId:'@s123:e1'},headless));
 assert.throws(()=>requireDesktopPermission('desktop_press',{key:'ctrl+s',interactionMode:'headed'},headless),
   e=>e.code==='DESKTOP_POLICY_DENIED');
 assert.doesNotThrow(()=>requireDesktopPermission('desktop_press',{key:'ctrl+s',interactionMode:'headed'},headed));
 assert.throws(()=>requireDesktopPermission('desktop_session',{action:'start',cursor:true},headed),
   e=>e.code==='DESKTOP_POLICY_DENIED');
});

test('cancelled native operation refuses before binary discovery',async()=>{
 const {runNative}=await import('../dist/desktop/adapter.js');
 const controller=new AbortController();controller.abort();
 await assert.rejects(runNative('snapshot',[],1000,1024,controller.signal),
    e=>e.code==='DESKTOP_CANCELLED'&&e.partialResult?.disposition?.delivery==='not_delivered');
});

test('journal does not persist Desktop input text, accessible values or screenshot bytes',async()=>{
 const {RecordJournal}=await import('../dist/record-journal.js');
 const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'deskbeacon-desktop-journal-'));
 try{
  const journal=new RecordJournal(root);
  const desktop=journal.start('desktop-unit-input','desktop_input',{deviceId:'d',action:'set_value',refId:'@s123:e2',text:'SECRET_INPUT_TEST'});
  journal.finish('desktop-unit-input',{ok:true,command:'set-value',data:{value:'SECRET_VALUE_TEST',disposition:{delivery:'delivered_verified'}}},'completed');
  const snap=journal.start('desktop-unit-snapshot','desktop_snapshot',{deviceId:'d',name:'private'});
  journal.finish('desktop-unit-snapshot',{ok:true,command:'snapshot',data:{snapshot_id:'s123',ref_count:1,tree:{name:'SECRET_UI_TEST'}}},'completed');
  const shot=journal.start('desktop-unit-shot','screen_capture',{deviceId:'d',target:'window',windowId:'w-1'});
  journal.finish('desktop-unit-shot',{base64:'SECRET_BASE64_TEST',mimeType:'image/jpeg',width:22,height:22,sizeBytes:100},'completed');
  const contents=[desktop,snap,shot].map(p=>readFileSync(journal.path(p),'utf8')).join('\n');
  for(const secret of ['SECRET_INPUT_TEST','SECRET_VALUE_TEST','SECRET_UI_TEST','SECRET_BASE64_TEST'])
    assert.ok(!contents.includes(secret),secret);
 }finally{rmSync(root,{recursive:true,force:true});}
});
