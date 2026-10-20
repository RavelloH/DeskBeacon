import {runStorageMigrations,migrationRequired,codeVersion,type MigrationResult} from './storage-migrations.js';
export {migrationRequired,codeVersion} from './storage-migrations.js';

export async function migrateCommand(interactive:boolean):Promise<MigrationResult>{
 if(interactive&&process.stdin.isTTY&&process.stdout.isTTY){
  const {migrationTui}=await import('./migration-tui.js');
  return migrationTui();
 }
 let previous=-1,stage='';
 const result=await runStorageMigrations({onProgress:progress=>{
  const bucket=Math.floor(progress.percent/5)*5;
  if(bucket===previous&&stage===progress.stage)return;
  previous=bucket;stage=progress.stage;
  const eta=progress.etaMs===null?'正在估算剩余时间':('预计剩余 '+Math.ceil(progress.etaMs/1000)+' 秒');
  process.stdout.write('DeskBeacon 数据迁移 '+progress.from+' → '+progress.to+'  '+
   bucket+'% ('+progress.completed+'/'+progress.total+') '+progress.stage+' · '+eta+'\n');
 }});
 return result;
}
