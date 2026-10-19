// Run after `pnpm --filter deskbeacon build`:
//   node --expose-gc apps/client/test/bench-tui-io.mjs busy 60000 15000
// Uses a production-mode Ink terminal, no device/Cloudflare/network dependency.
import {PassThrough} from 'node:stream';
process.env.NODE_ENV='production';
delete process.env.CI;
const React=(await import('react')).default;
const {render}=await import('ink');
const {App}=await import('../dist/tui.js');
const scenario=process.argv[2]??'busy';
const measureMs=Number(process.argv[3]??12000);
const sampleMs=Number(process.argv[4]??0);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const input=new PassThrough();
input.isTTY=true;input.setRawMode=()=>input;input.ref=()=>input;input.unref=()=>input;
const output=new PassThrough();
output.isTTY=true;output.columns=160;output.rows=43;output.getColorDepth=()=>24;
let chunks=0,bytes=0;
output.on('data',value=>{chunks++;bytes+=value.length;});
const app=render(React.createElement(App,{demoScenario:scenario}),{
 stdin:input,stdout:output,exitOnCtrlC:false,patchConsole:false
});
try {
 await pause(1200); // Warm up Ink, layout, JIT and terminal initialization.
 chunks=0;bytes=0;
 const cpuStart=process.cpuUsage(),start=performance.now();
 const samples=[];
 while(performance.now()-start<measureMs){
  await pause(Math.min(sampleMs||measureMs,Math.max(1,measureMs-(performance.now()-start))));
  if(sampleMs){
   global.gc?.();
   const {heapUsed,rss}=process.memoryUsage();
   samples.push({elapsedS:+((performance.now()-start)/1000).toFixed(1),
    heapAfterGcMiB:+(heapUsed/1048576).toFixed(1),rssMiB:+(rss/1048576).toFixed(1)});
  }
 }
 const wallMs=performance.now()-start,cpu=process.cpuUsage(cpuStart);
 const cpuMs=(cpu.user+cpu.system)/1000;
 console.log(JSON.stringify({scenario,wallMs:+wallMs.toFixed(0),
  writes:chunks,writesPerSecond:+(chunks*1000/wallMs).toFixed(1),
  bytes,outputKiBPerSecond:+(bytes*1000/wallMs/1024).toFixed(1),
  cpuMs:+cpuMs.toFixed(0),cpuPercentOfOneCore:+(cpuMs/wallMs*100).toFixed(1),samples},null,2));
}finally{
 app.unmount();
 input.destroy();output.destroy();
}
