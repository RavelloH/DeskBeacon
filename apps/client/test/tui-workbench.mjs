import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

// Ink intentionally disables its terminal renderer when CI is set. This test
// owns a real PassThrough terminal, so keep the real renderer enabled in CI.
const previousCi=process.env.CI;
const previousForceColor=process.env.FORCE_COLOR;
delete process.env.CI;
// Verify actual ANSI foreground colors, not only the text snapshot.
process.env.FORCE_COLOR='3';

const React=(await import('react')).default;
const {render,Box,Text}=await import('ink');
const {App}=await import('../dist/tui.js');
const {TuiInputBridge}=await import('../dist/tui-input.js');
const {cellWidth,fit,paneLayout,tableColumns,detailScrollStatus}=await import('../dist/tui-layout.js');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});

class TerminalCapture{
  constructor(output){this.output=output;this.raw='';output.on('data',chunk=>this.raw+=chunk.toString('utf8'));}
  dimensions(){return {width:this.output.columns,height:this.output.rows};}
  snapshot(){
    const {width,height}=this.dimensions();
    const cells=Array.from({length:height},()=>Array(Math.max(1,width)).fill(' '));
    let row=0,column=0,index=0;
    const clamp=()=>{row=Math.max(0,Math.min(height-1,row));column=Math.max(0,Math.min(width,column));};
    const clearLine=(from,to)=>{
      if(row<0||row>=height)return;
      for(let c=Math.max(0,from);c<Math.min(width,to);c++)cells[row][c]=' ';
    };
    const writeText=text=>{
      for(const {segment} of segmenter.segment(text)){
        const size=cellWidth(segment);
        if(size===0){
          if(column>0&&column<=width)cells[row][column-1]=(cells[row][column-1]??'')+segment;
          continue;
        }
        if(row>=0&&row<height&&column<width){
          cells[row][column]=segment;
          for(let c=1;c<size&&column+c<width;c++)cells[row][column+c]='';
        }
        column+=size;
      }
      clamp();
    };
    const csi=(sequence)=>{
      const final=sequence.at(-1),rawParams=sequence.slice(0,-1).replace(/^\?/,'');
      const params=rawParams.split(';').filter(Boolean).map(Number),first=params[0]||1;
      if(final==='A')row-=first;
      else if(final==='B')row+=first;
      else if(final==='C')column+=first;
      else if(final==='D')column-=first;
      else if(final==='G')column=first-1;
      else if(final==='H'||final==='f'){row=(params[0]||1)-1;column=(params[1]||1)-1;}
      else if(final==='J'){
        if((params[0]??0)===2){for(let r=0;r<height;r++)cells[r].fill(' ');}
        else if((params[0]??0)===0){clearLine(column,width);for(let r=row+1;r<height;r++)cells[r].fill(' ');}
      }else if(final==='K'){
        const mode=params[0]??0;
        if(mode===0)clearLine(column,width);
        else if(mode===1)clearLine(0,column+1);
        else if(mode===2)clearLine(0,width);
      }else if(final==='X')clearLine(column,column+first);
      clamp();
    };
    while(index<this.raw.length){
      const char=this.raw[index];
      if(char==='\x1b'){
        if(this.raw[index+1]==='['){
          let end=index+2;
          while(end<this.raw.length&&!(this.raw.charCodeAt(end)>=0x40&&this.raw.charCodeAt(end)<=0x7e))end++;
          if(end>=this.raw.length)break;
          csi(this.raw.slice(index+2,end+1));index=end+1;continue;
        }
        if(this.raw[index+1]===']'){
          const bell=this.raw.indexOf('\x07',index+2),st=this.raw.indexOf('\x1b\\',index+2);
          const end=bell<0?st<0?-1:st+2:st<0?bell+1:Math.min(bell+1,st+2);
          if(end<0)break;index=end;continue;
        }
        index+=2;continue;
      }
      if(char==='\r'){column=0;index++;continue;}
      if(char==='\n'){row++;column=0;clamp();index++;continue;}
      if(char==='\b'){column=Math.max(0,column-1);index++;continue;}
      if(char==='\t'){column=(Math.floor(column/8)+1)*8;clamp();index++;continue;}
      let end=index+1;
      while(end<this.raw.length&&!/[\x1b\r\n\b\t]/.test(this.raw[end]))end++;
      writeText(this.raw.slice(index,end));index=end;
    }
    return cells.map(line=>line.join('').replace(/\s+$/,'')).join('\n');
  }
  position(needle){
    const lines=this.snapshot().split('\n');
    for(let y=0;y<lines.length;y++){
      const x=lines[y].indexOf(needle);
      if(x>=0)return {row:y,column:cellWidth(lines[y].slice(0,x)),line:lines[y]};
    }
    return null;
  }
}

function terminal(width,height){
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
  const output=new PassThrough();output.isTTY=true;output.columns=width;output.rows=height;output.getColorDepth=()=>24;
  const capture=new TerminalCapture(output);
  return {input,output,capture};
}

async function mountDemo(scenario,width,height){
  const io=terminal(width,height);
  const bridge=new TuiInputBridge(io.input);
  const app=render(React.createElement(App,{demoScenario:scenario,mouseEvents:bridge.mouse}),{
    stdin:bridge.keyboard,stdout:io.output,exitOnCtrlC:false,
  });
  await waitFor(()=>io.capture.snapshot().includes('ACTIVITY'),`Ink did not render ${scenario}: ${io.capture.snapshot().slice(0,2500)}`);
  await sleep(160); // Wait for Ink input effects to attach after the initial paint.
  const send=async value=>{io.input.write(value);await sleep(55);};
  const resize=async(nextWidth,nextHeight)=>{
    io.output.columns=nextWidth;io.output.rows=nextHeight;io.output.emit('resize');await sleep(100);
  };
  const close=async()=>{
    try{app.unmount();}catch{}
    bridge.dispose();io.input.destroy();io.output.destroy();
  };
  return {...io,app,send,resize,close};
}

async function waitFor(predicate,message,timeoutMs=2500){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(predicate())return;await sleep(20);}
  assert.fail(message);
}

function assertPosition(screen,needle){
  const position=screen.position(needle);
  assert.ok(position,`screen is missing ${JSON.stringify(needle)}\n${screen.snapshot()}`);
  return position;
}

async function renderCellFixture(){
  const width=28,{input,output,capture}=terminal(width,4);
  const sample='Claude 🦊 · 中文路径 C:\\项目\\src\\daemon.ts';
  const fitted=fit(sample,width);
  const app=render(React.createElement(Box,{flexDirection:'column',width},
    React.createElement(Text,null,fitted),React.createElement(Text,null,'NEXT ROW')),
    {stdin:input,stdout:output,exitOnCtrlC:false});
  try{
    await waitFor(()=>capture.snapshot().includes('NEXT ROW'),'Ink did not render the Unicode cell fixture');
    const first=assertPosition(capture,'Claude');
    const next=assertPosition(capture,'NEXT ROW');
    assert.equal(cellWidth(fitted),width,'CJK and emoji cells must fit the declared table width');
    assert.equal(next.row,first.row+1,'a wide Unicode cell must remain one terminal row high');
  }finally{app.unmount();input.destroy();output.destroy();}
}

try{
  assert.equal(paneLayout(120,20,32).sideBySide,true,'landscape screens use left/right panes');
  assert.equal(paneLayout(40,30,50).sideBySide,false,'portrait screens use top/bottom panes');
  assert.equal(paneLayout(42,30,42).sideBySide,false,'square screens use top/bottom panes');
  for(const terminalWidth of [96,100,105,110,112,119,120,135,158,180]){
    const originalActivityWidth=Math.floor((terminalWidth-1)*.72);
    const oldColumns=tableColumns(Math.max(1,originalActivityWidth-2),12);
    const panel=paneLayout(terminalWidth,24,36,12);
    const newColumns=tableColumns(Math.max(1,panel.activityWidth-2),12,panel.detailGain);
    const column=(list,name)=>list.find(item=>item.key===name)?.width??0;
    assert.equal(column(oldColumns,'action')-column(newColumns,'action'),panel.detailGain,
      'DETAIL gains must come only from ACTION at width '+terminalWidth);
    assert.equal(column(oldColumns,'result'),column(newColumns,'result'),
      'RESULT column must not shrink to expand DETAIL at width '+terminalWidth);
    assert.ok(column(newColumns,'action')>=12,'ACTION still has a readable minimum width');
    assert.equal(panel.detailWidth,terminalWidth-1-panel.activityWidth);
    assert.ok(panel.detailGain<=9,'DETAIL should widen by at most nine columns');
  }
  console.log('PASS DETAIL width transfer only reduces ACTION, preserves RESULT and AGENT across terminal sizes');
  assert.equal(detailScrollStatus(124,27,0),'0 / 97');
  assert.equal(detailScrollStatus(124,27,40),'40 / 97');
  assert.equal(detailScrollStatus(124,27,99),'97 / 97','offset is clamped to actual scrollable rows');
  assert.equal(detailScrollStatus(27,27,0),'','no scroll indicator when all content fits');
  assert.equal(detailScrollStatus(15,27,0),'','short content does not report fake scroll range');
  console.log('PASS DETAIL scroll count excludes current viewport rows');
  for(const column of tableColumns(112)){
    for(const value of ['中文 Agent 路径','Claude 🦊 ChatGPT','e\u0301 · 文件操作']){
      assert.equal(cellWidth(fit(value,column.width)),column.width,
        `column ${column.key} must be padded by terminal cells for ${value}`);
    }
  }
  await renderCellFixture();
  console.log('PASS Unicode CJK/emoji table-cell width and Ink line height');

  const layout=await mountDemo('busy',120,32);
  try{
    const activityWide=assertPosition(layout.capture,'ACTIVITY');
    const detailWide=assertPosition(layout.capture,'DETAIL');
    assert.equal(activityWide.row,detailWide.row,'landscape panes must share the same header row');
    assert.ok(detailWide.column>activityWide.column,'landscape detail must be to the right of activity');
    assert.ok(!layout.capture.snapshot().includes('以上运行中 · 以下为历史'),'pinned running rows need no extra separator');
    const initial=layout.capture.snapshot();
    const liveAt=layout.capture.raw.lastIndexOf('● LIVE');
    assert.ok(liveAt>0,'LIVE indicator should be present');
    assert.match(layout.capture.raw.slice(Math.max(0,liveAt-120),liveAt),
      /\x1b\[38;2;146;214;162m/,
      'LIVE dot and label should use the success-green ANSI color');
    const screenLines=initial.split('\n');
    const actionHeading=screenLines.findIndex((row,index)=>index>detailWide.row&&
      row.includes('│ ACTION'));
    assert.ok(actionHeading>0,'ACTION should occupy a separate line under its divider\n'+initial);
    const thinDivider=screenLines[actionHeading-1];
    assert.ok(thinDivider.includes('├')&&thinDivider.includes('─────'),
      'thin full-width rule must connect to the vertical detail border');
    assert.ok(!thinDivider.includes('┠'),'divider junction must be thin on both sides');
    const detailTitleLine=screenLines[detailWide.row]??'';
    assert.ok(!detailTitleLine.includes(' / '),
      'DETAIL should suppress the scroll indicator when the selected entry fits the viewport');
    assert.ok(!thinDivider.includes('ACTION'),'section titles must not appear inside the rule');
    assert.ok(!thinDivider.includes('━'),'section dividers must use light line glyphs');
    assert.ok(screenLines.some(row=>row.includes('│ TOOL')&&row.includes('│')),
      'tabular detail fields should retain a single left inner margin');
    const runningRow=screenLines.find(row=>row.includes('17s')&&row.includes('ChatGPT'));
    const finishedRow=screenLines.find(row=>row.includes('2.6s')&&row.includes('ChatGPT'));
    assert.ok(runningRow&&finishedRow,'fixture must render both running and completed DUR columns');
    const elapsedEnd=(row,value)=>cellWidth(row.slice(0,row.indexOf(value)))+cellWidth(value);
    assert.equal(elapsedEnd(runningRow,'17s'),elapsedEnd(finishedRow,'2.6s'),
      'running DUR must align to the same right edge as completed DUR');
    const beforeDuration=initial.match(/DUR\s*│\s*([0-9.]+s)/)?.[1];
    assert.ok(beforeDuration,'running operation must show decimal duration in DETAIL');
    await sleep(340);
    const afterDuration=layout.capture.snapshot().match(/DUR\s*│\s*([0-9.]+s)/)?.[1];
    assert.notEqual(afterDuration,beforeDuration,'DETAIL duration should refresh at 100ms without polling the server');

    await layout.send('j');
    await waitFor(()=>layout.capture.snapshot().includes('2 / 6'),'down must select the next activity\n'+layout.capture.snapshot());
    await layout.send('k');
    await waitFor(()=>layout.capture.snapshot().includes('构建桌面客户端'),'up must restore the prior activity');

    await layout.send('j');
    await layout.send('6');
    await waitFor(()=>layout.capture.snapshot().includes('ACTIVITY 7'),'new demo activity should be added');
    assert.ok(layout.capture.snapshot().includes('3 / 7'),
      'the selected activity must remain selected when a newer row arrives');

    for(let i=0;i<40;i++)await layout.send('6');
    await waitFor(()=>layout.capture.snapshot().includes('ACTIVITY 47'),
      'demo should retain the full activity list as newer records arrive');
    assert.ok(layout.capture.snapshot().includes('43 / 47'),'the same selected activity should remain available after many insertions');
    await layout.send('f');
    await waitFor(()=>layout.capture.snapshot().includes('● LIVE'),'f returns to following new events');
    await layout.send('\x1b[<65;20;9M');
    await waitFor(()=>layout.capture.snapshot().includes('2 / 47'),'one wheel event moves exactly one activity');
    for(let step=0;step<10;step++)layout.input.write('\x1b[<65;20;9M');
    await waitFor(()=>layout.capture.snapshot().includes('12 / 47'),
      'rapid wheel messages must accumulate without losing selection');
    for(let step=0;step<11;step++)layout.input.write('\x1b[<64;20;9M');
    await waitFor(()=>layout.capture.snapshot().includes('● LIVE'),'wheel can scroll back to live follow');
    console.log('PASS mouse wheel burst navigation, stable viewport and live follow');

    await layout.resize(40,50);
    const activityPortrait=assertPosition(layout.capture,'ACTIVITY');
    const detailPortrait=assertPosition(layout.capture,'DETAIL');
    assert.ok(activityPortrait.row<detailPortrait.row,'portrait panes must stack vertically');
    await layout.resize(42,42);
    const activitySquare=assertPosition(layout.capture,'ACTIVITY');
    const detailSquare=assertPosition(layout.capture,'DETAIL');
    assert.ok(activitySquare.row<detailSquare.row,'square panes must stack vertically');
    await layout.resize(31,40);
    assert.ok(assertPosition(layout.capture,'ACTIVITY').row<assertPosition(layout.capture,'DETAIL').row,
      'narrow portrait terminals still provide stacked panes');
    for(let n=0;n<18;n++){
      const [width,height]=[[120,32],[97,25],[80,28],[47,30],[31,40],[135,19]][n%6];
      await layout.resize(width,height);
      if(n%3===0)await layout.send('6');
    }
    await layout.resize(120,32);
    assert.ok(layout.capture.snapshot().includes('ACTION'));
    assert.ok(layout.capture.snapshot().includes('RESULT'));
    console.log('PASS 18 rapid Ink resize and live activity redraw cycles');
  }finally{await layout.close();}
  console.log('PASS responsive layouts, combined date statistics and stable selection');

  const search=await mountDemo('connected',120,32);
  try{
    // SGR mouse left-click inside the existing 3-row search box edits search.
    await search.send('\x1b[<0;10;3M');await search.send('Codex');
    await waitFor(()=>search.capture.snapshot().includes('ACTIVITY 1'),'search previews matches before Enter');
    // Move the mouse repeatedly while editing: raw SGR packets must never
    // appear in the search text or corrupt the live result query.
    for(let n=0;n<18;n++)search.input.write('\x1b[<35;'+(59+n)+';3M');
    search.input.write('\x1b[<35;59;');search.input.write('4M');
    await sleep(160);
    assert.ok(!search.capture.snapshot().includes('[<35;'),'search must discard mouse control sequences');
    assert.ok(search.capture.snapshot().includes('ACTIVITY 1'),'mouse motion must not alter search result');
    await search.send('\r');
    await waitFor(()=>search.capture.snapshot().includes('ACTIVITY 1'),'search must match the OAuth actor name');
    assert.ok(search.capture.snapshot().includes('Codex'),'actor search result must be visible');
    await search.send('\x1b');
    await waitFor(()=>!search.capture.snapshot().includes('⌕ Codex'),
      'Esc must finish clearing the previous filter before typing another query');
    await search.send('S');await search.send('pnpm');await search.send('\r');
    await waitFor(()=>search.capture.snapshot().includes('ACTIVITY 1'),'search must match a command target\n'+search.capture.snapshot().slice(0,1200));
    assert.ok(search.capture.snapshot().includes('pnpm'),'command search result must be visible');
  }finally{await search.close();}
  console.log('PASS activity search by Actor and command');
  const expansion=await mountDemo('connected',120,36);
  try{
    await expansion.send('s');await expansion.send('检查项目配置');await expansion.send('\r');
    await waitFor(()=>expansion.capture.snapshot().includes('ACTIVITY 1'),
      'file read must be uniquely selected for full result test\n'+expansion.capture.snapshot().slice(0,1500));
    await expansion.send('o');
    await waitFor(()=>expansion.capture.snapshot().includes('[RESULT]'),
      'o should open structured result for fs_read instead of empty stdout');
    await waitFor(()=>expansion.capture.snapshot().includes('FILE CONTENT'),
      'full result view should display the file content');
    const view=expansion.capture.snapshot();
    assert.ok(view.includes('src/module-'),'complete result view must show original content');
    assert.ok(!view.includes('摘要未展示'),'full result must not repeat the summary limit');
    await expansion.send('c');
    await waitFor(()=>expansion.capture.snapshot().includes('DEMO · 复制'),
      'c should copy full receipt content, not the bounded summary');
    await expansion.send('i');
    await waitFor(()=>expansion.capture.snapshot().includes('[INPUT]'),
      'i should still open original parameters for file tool');
  }finally{await expansion.close();}
  console.log('PASS o expands structured file-read result, i expands input');
  const mouse=await mountDemo('connected',160,38);
  try{
    let linkedY=0;
    const beforeHover=mouse.capture.raw.length;
    for(let row=7;row<=15;row++){
      mouse.input.write('\x1b[<35;49;'+row+'M');
      await sleep(75);
      if(mouse.capture.raw.slice(beforeHover).includes('\x1b[4m')){linkedY=row;break;}
    }
    assert.ok(linkedY,'hovering a file path must underline the filename');
    assert.ok(!mouse.capture.snapshot().includes('Ctrl+点击文件'),'help bar must omit file shortcut');
    mouse.input.write('\x1b[<16;49;'+linkedY+'M');
    await waitFor(()=>mouse.capture.snapshot().includes('文件不存在'),
      'Ctrl+click should validate file existence without shell execution');
    mouse.input.write('\x1b[<35;10;2M');
    await sleep(90);
    assert.ok(!mouse.capture.snapshot().includes('Ctrl+点击文件'),'shortcut is not part of help bar');
    console.log('PASS file hover, Ctrl+click path validation and hover reset');
  }finally{await mouse.close();}

  const controls=await mountDemo('busy',100,16);
  try{
    // The foreground command is the third historical entry after the running row.
    for(let i=0;i<3;i++)await controls.send('j');
    await waitFor(()=>controls.capture.snapshot().includes('TypeScript'),'keyboard navigation reaches the command activity');
    await controls.send('\t');await controls.send('j');
    const detailLine=assertPosition(controls.capture,'DETAIL').line;
    assert.match(detailLine,/1\s*\/\s*\d+/,'Tab must focus detail and show one line scrolled / remaining scrollable range');
    await controls.send('o');
    await waitFor(()=>controls.capture.snapshot().includes('OUTPUT'),'o opens the complete output inspector');
    await waitFor(()=>controls.capture.snapshot().includes('Checking protocol'),'demo output is displayed locally');
    assert.ok(controls.capture.snapshot().includes('[STDOUT]'),'output shows tabs');
    await controls.send('e');
    await waitFor(()=>controls.capture.snapshot().includes('[STDERR]'),'e switches stdout/stderr\n'+controls.capture.snapshot().slice(0,1300));
    await controls.send('i');
    await waitFor(()=>controls.capture.snapshot().includes('[INPUT]'),'i opens the input inspector');
    await waitFor(()=>controls.capture.snapshot().includes('PROGRAM'),'input shows full program invocation with line numbers');
    assert.match(controls.capture.snapshot(),/│ 1 │ pnpm\s/,
      'line numbers need one-cell left inset and a visible right separator');
    const totalRows=Number(/INPUT[^\n]*0 \/ (\d+)/.exec(controls.capture.snapshot())?.[1]??0);
    assert.ok(totalRows>0,'input inspector must expose scrollable full content');
    for(let i=0;i<totalRows+3;i++)await controls.send('j');
    await waitFor(()=>controls.capture.snapshot().includes(totalRows+' / '+totalRows),
      'scrolling reaches the end of the complete input detail\n'+controls.capture.snapshot().slice(0,1100));
    await controls.send('c');
    await waitFor(()=>controls.capture.snapshot().includes('DEMO · 复制'),'c copies complete inspector content');
    await controls.send('\x1b');
    await waitFor(()=>controls.capture.snapshot().includes('DETAIL'),'Esc returns to summary before switching pane');

    // Focus the task pane and prove x/X only show confirmation; n/Esc cancel it.
    await controls.send('\t');
    await controls.send('x');
    await waitFor(()=>controls.capture.snapshot().includes('停止 1 个进程'),'x asks before stopping one task\n'+controls.capture.snapshot().slice(0,1500));
    await controls.send('n');
    await waitFor(()=>!controls.capture.snapshot().includes('停止 1 个进程'),'n cancels stop confirmation');
    assert.ok(controls.capture.snapshot().includes('BACKGROUND 2'),'cancelling x leaves both tasks running');
    await controls.send('X');
    await waitFor(()=>controls.capture.snapshot().includes('停止 2 个进程'),'X asks before stopping all tasks');
    await controls.send('\x1b');
    await waitFor(()=>!controls.capture.snapshot().includes('停止 2 个进程'),'Esc cancels stop-all confirmation');
    assert.ok(controls.capture.snapshot().includes('BACKGROUND 2'),'cancelling X leaves both tasks running');

    await controls.send('7');
    await waitFor(()=>controls.capture.snapshot().includes('BACKGROUND 9'),'demo can show nine background tasks');
    for(let i=0;i<8;i++)await controls.send('j');
    await waitFor(()=>controls.capture.snapshot().includes('后台服务 #9'),
      'task navigation reaches the last of nine tasks\n'+controls.capture.snapshot());
    assert.ok(controls.capture.snapshot().includes('9 / 9'));
  }finally{await controls.close();}
  console.log('PASS detail scrolling, Tab focus, local stdout/stderr, stop cancellation and 9-task navigation');

  const commands=await mountDemo('connected',120,32);
  try{
    await commands.send('/');
    await commands.send('config');await commands.send('\r');
    await waitFor(()=>commands.capture.snapshot().includes('CONNECTION'),'slash should open the command palette');
    await commands.send('\x1b');
    await commands.send('?');
    await waitFor(()=>commands.capture.snapshot().includes('f 最新')&&
      commands.capture.snapshot().includes('x 停止'),
      'global help must show follow and stop instead of DETAIL-only shortcuts');
    const footer=commands.capture.snapshot().split('\n').at(-1)??'';
    assert.match(footer,/s 搜索.*\/ 指令.*f 最新.*x 停止.*q 退出/,
      'bottom bar must consistently show global shortcuts at 120 columns');
    assert.ok(!footer.includes('i 输入')&&!footer.includes('o 输出')&&!footer.includes('c 复制'),
      'DETAIL-only hints belong in the DETAIL pane, not the global footer');
    await commands.send('/');
    await commands.send('nonsense');
    await commands.send('\r');
    await waitFor(()=>commands.capture.snapshot().includes('命令：config'),
      'unknown commands should still show an error');
    await sleep(3400);
    assert.ok(!commands.capture.snapshot().includes('命令：config'),'transient notice must expire');
    console.log('PASS slash commands, global footer hints and notice expiration');
  }finally{await commands.close();}

  const interrupted=await mountDemo('connected',120,32);
  try{
    await interrupted.send('\x03');
    await waitFor(()=>interrupted.capture.snapshot().includes('再次按 Ctrl+C'),
      'first Ctrl+C must ask for confirmation without exiting');
    const finished=interrupted.app.waitUntilExit();
    await interrupted.send('\x03');
    await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(Error('second Ctrl+C did not exit Ink')),2500))]);
    console.log('PASS Ctrl+C confirmation requires two presses');
  }finally{await interrupted.close();}

  const quitting=await mountDemo('crowded',120,32);
  try{
    const done=quitting.app.waitUntilExit();
    await quitting.send('q');
    await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('q did not exit Ink')),2500))]);
  }finally{await quitting.close();}
  console.log('PASS q exits the workbench');
}finally{
  if(previousCi!==undefined)process.env.CI=previousCi;
  if(previousForceColor===undefined)delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR=previousForceColor;
}
