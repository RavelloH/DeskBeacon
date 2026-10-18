import {spawn} from 'node:child_process';
/** Pipe text; never interpolate the selected command into a shell expression. */
export async function copyText(text:string):Promise<void>{
 const choices: [string,string[]][] = process.platform==='win32'
  ? [['powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',
     '[Console]::InputEncoding = [Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())']]]
  : process.platform==='darwin'?[['pbcopy',[]]]:[['wl-copy',[]],['xclip',['-selection','clipboard']],['xsel',['--clipboard','--input']]];
 for(const [program,args] of choices){
  const ok=await new Promise<boolean>(resolve=>{
   const child=spawn(program,args,{windowsHide:true,stdio:['pipe','ignore','ignore']});
   const timer=setTimeout(()=>{child.kill('SIGKILL');resolve(false);},2000);
   child.once('error',()=>{clearTimeout(timer);resolve(false);});
   child.once('close',code=>{clearTimeout(timer);resolve(code===0);});
   child.stdin.on('error',()=>{});child.stdin.end(text,'utf8');
  });
  if(ok)return;
 }
 throw Error('系统剪贴板不可用');
}
