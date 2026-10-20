import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const env={...process.env,DESKBEACON_DATA_DIR:join(root,'.test-data'),
  DESKBEACON_IPC_PATH:process.platform==='win32'
    ? '\\\\.\\pipe\\deskbeacon-ci-'+process.pid
    : join(root,'.test-data','ipc-test.sock')};
for(const name of ['supervisor.mjs','workspace-command.mjs','terminal-errors.mjs','action-link.mjs','action-dedup.mjs','detail-numbered.mjs','detail-inspector.mjs','command-palette.mjs','local-stream.mjs','terminal-title.mjs','tui-input.mjs','ipc.mjs','connect-recovery.mjs','service-recovery.mjs','device-rename.mjs','cli-lifecycle.mjs','demo-mode.mjs','agent-ux.mjs','file-range.mjs','fs-read-many.mjs','fs-edit.mjs','fs-manage.mjs','process-encoding.mjs','win-oem-encoding.mjs','native-platform.mjs','tool-presentation.mjs','activity-model.mjs','activity-paging.mjs','output-paging.mjs','tui-render.mjs','tui-workbench.mjs',...(process.platform==='win32'?['job-tree.mjs','job-daemon-crash.mjs']:[])]){
  const args=[join(root,'apps','client','test',name)];
  const exitCode=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
    const deadline=setTimeout(()=>{
      console.error('Local test exceeded 100 seconds:',name);
      child.kill('SIGKILL');
      resolve(124);
    },100_000);
    child.once('error',error=>{clearTimeout(deadline);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(deadline);resolve(code??(signal?1:0));});
  });
  if(exitCode!==0){console.error('Local test failed',name,exitCode);process.exitCode=exitCode;break;}
}
