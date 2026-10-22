import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
// Test cases simulate an interactive TTY with Ink; CI flags disable Ink rendering.
// Clear these flags only for isolated test child processes, never production.
const env={...process.env,CI:undefined,GITHUB_ACTIONS:undefined,DESKBEACON_DATA_DIR:join(root,'.test-data'),
  DESKBEACON_IPC_PATH:process.platform==='win32'
    ? '\\\\.\\pipe\\deskbeacon-ci-'+process.pid
    : join(root,'.test-data','ipc-test.sock')};
for(const name of ['record-journal.mjs','selected-file-preview.mjs','record-dispatch.mjs','record-execution.mjs','record-crash-recovery.mjs','legacy-migration.mjs','legacy-startup.mjs','storage-version-upgrade.mjs','storage-migrate-cli.mjs','migration-screen.mjs','migration-demo.mjs','migration-demo-cli.mjs','supervisor.mjs','workspace-command.mjs','terminal-errors.mjs','action-link.mjs','action-dedup.mjs','detail-numbered.mjs','detail-inspector.mjs','batch-detail.mjs','diagnostics-logging.mjs','config-cli.mjs','setup-flow.mjs','setup-screen.mjs','setup-demo.mjs','setup-demo-cli.mjs','update-flow.mjs','update-screen.mjs','update-cli.mjs','update-demo.mjs','update-demo-cli.mjs','help-zh.mjs','command-palette.mjs','local-stream.mjs','terminal-title.mjs','tui-input.mjs','tui-terminal-guard.mjs','ansi-render-regression.mjs','foreground-survivability.mjs','ipc-events.test.mjs','ipc-integration.test.mjs','ipc.mjs','connect-recovery.mjs','service-recovery.mjs','service-restart.mjs','service-start-migration.mjs','device-rename.mjs','cli-lifecycle.mjs','demo-mode.mjs','agent-ux.mjs','file-range.mjs','fs-read-many.mjs','fs-edit.mjs','fs-manage.mjs','process-encoding.mjs','win-oem-encoding.mjs','native-platform.mjs','tool-presentation.mjs','activity-model.mjs','activity-paging.mjs','output-paging.mjs','record-journal.mjs','legacy-migration.mjs','legacy-startup.mjs','record-dispatch.mjs','record-execution.mjs','record-crash-recovery.mjs','record-ipc-live.mjs','tui-render.mjs','tui-file-preview.mjs','tui-workbench.mjs',...(process.platform==='win32'?['job-tree.mjs','job-daemon-crash.mjs']:[])]){
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
