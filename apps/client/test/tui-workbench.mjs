import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

// Ink intentionally disables its terminal renderer when CI is set. This test
// owns a real PassThrough terminal, so keep the real renderer enabled in CI.
const previousCi=process.env.CI;
delete process.env.CI;

const React=(await import('react')).default;
const {render,Box,Text}=await import('ink');
const {App}=await import('../dist/tui.js');
const {cellWidth,fit,paneLayout,tableColumns}=await import('../dist/tui-layout.js');

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
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>input;
  const output=new PassThrough();output.isTTY=true;output.columns=width;output.rows=height;output.getColorDepth=()=>24;
  const capture=new TerminalCapture(output);
  return {input,output,capture};
}

async function mountDemo(scenario,width,height){
  const io=terminal(width,height);
  const app=render(React.createElement(App,{demoScenario:scenario}),{
    stdin:io.input,stdout:io.output,exitOnCtrlC:false,
  });
  await waitFor(()=>io.capture.snapshot().includes('ACTIVITY'),`Ink did not render ${scenario}`);
  const send=async value=>{io.input.write(value);await sleep(55);};
  const resize=async(nextWidth,nextHeight)=>{
    io.output.columns=nextWidth;io.output.rows=nextHeight;io.output.emit('resize');await sleep(100);
  };
  const close=async()=>{
    try{app.unmount();}catch{}
    io.input.destroy();io.output.destroy();
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
    assert.ok(layout.capture.snapshot().includes('以上运行中 · 以下为历史'),'running/history separator is visible');

    await layout.send('j');
    await waitFor(()=>layout.capture.snapshot().includes('检查开发服务健康状态'),'down must select the next activity');
    await layout.send('k');
    await waitFor(()=>layout.capture.snapshot().includes('构建桌面客户端'),'up must restore the prior activity');

    await layout.send('j');
    await layout.send('6');
    await waitFor(()=>layout.capture.snapshot().includes('ACTIVITY 7'),'new demo activity should be added');
    assert.ok(layout.capture.snapshot().includes('检查开发服务健康状态'),
      'the selected activity must remain selected when a newer row arrives');

    for(let i=0;i<40;i++)await layout.send('6');
    await waitFor(()=>layout.capture.snapshot().includes('历史快照'),
      'a pinned record evicted from the recent activity window must retain its detail');
    assert.ok(layout.capture.snapshot().includes('检查开发服务健康状态'));
    await layout.send('f');
    await waitFor(()=>layout.capture.snapshot().includes('● live'),'f returns to following new events');

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
  }finally{await layout.close();}
  console.log('PASS responsive wide/portrait/square layout, history separator and stable selection');

  const search=await mountDemo('connected',120,32);
  try{
    await search.send('/');await search.send('Codex');
    await waitFor(()=>search.capture.snapshot().includes('ACTIVITY 1'),'search previews matches before Enter');
    await search.send('\r');
    await waitFor(()=>search.capture.snapshot().includes('ACTIVITY 1'),'search must match the OAuth actor name');
    assert.ok(search.capture.snapshot().includes('Codex'),'actor search result must be visible');
    await search.send('\x1b');
    await search.send('/');await search.send('pnpm');await search.send('\r');
    await waitFor(()=>search.capture.snapshot().includes('ACTIVITY 1'),'search must match a command target');
    assert.ok(search.capture.snapshot().includes('pnpm'),'command search result must be visible');
  }finally{await search.close();}
  console.log('PASS activity search by Actor and command');

  const controls=await mountDemo('busy',100,16);
  try{
    // The foreground command is the third historical entry after the running row.
    for(let i=0;i<3;i++)await controls.send('j');
    await waitFor(()=>controls.capture.snapshot().includes('TypeScript'),'keyboard navigation reaches the command activity');
    await controls.send('\t');await controls.send('j');
    const detailLine=assertPosition(controls.capture,'DETAIL').line;
    assert.match(detailLine,/2\s*\//,'Tab must focus detail so j scrolls its pages');
    await controls.send('o');
    await waitFor(()=>controls.capture.snapshot().includes('LOCAL OUTPUT'),'o opens the local output view');
    await waitFor(()=>controls.capture.snapshot().includes('Checking protocol'),'demo output is displayed locally');
    assert.ok(controls.capture.snapshot().includes('stdout'));
    await controls.send('e');
    await waitFor(()=>controls.capture.snapshot().includes('stderr'),'e switches between stdout and stderr');
    await controls.send('\x1b');

    // Focus the task pane and prove x/X only show confirmation; n/Esc cancel it.
    await controls.send('\t');
    await controls.send('x');
    await waitFor(()=>controls.capture.snapshot().includes('停止 1 个进程'),'x asks before stopping one task');
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
    assert.ok(controls.capture.snapshot().includes('▸ task-9'));
  }finally{await controls.close();}
  console.log('PASS detail scrolling, Tab focus, local stdout/stderr, stop cancellation and 9-task navigation');

  const quitting=await mountDemo('crowded',120,32);
  try{
    const exit=quitting.app.waitUntilExit();
    await quitting.send('q');
    await Promise.race([exit,new Promise((_,reject)=>setTimeout(()=>reject(Error('q did not exit Ink')),2500))]);
  }finally{await quitting.close();}
  console.log('PASS q exits the workbench');
}finally{
  if(previousCi!==undefined)process.env.CI=previousCi;
}
