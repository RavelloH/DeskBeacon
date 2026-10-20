import type {MigrationProgress} from './storage-migrations.js';

/** Pure, deterministic migration preview. No SQLite, filesystem or Runtime access. */
export const MIGRATION_DEMO_DURATION_MS=24_000;
export const MIGRATION_DEMO_STEPS=[
  {stage:'准备本地存储',start:0,end:1500,doneStart:0,doneEnd:0},
  {stage:'迁移操作记录',start:1500,end:10000,doneStart:0,doneEnd:4180},
  {stage:'校验 JSONL 日志',start:10000,end:16000,doneStart:4180,doneEnd:8360},
  {stage:'检查旧版输出文件',start:16000,end:22000,doneStart:8360,doneEnd:11905},
  {stage:'压缩 SQLite 数据库',start:22000,end:23500,doneStart:11905,doneEnd:11905},
  {stage:'已完成 0.2.0 升级',start:23500,end:MIGRATION_DEMO_DURATION_MS,doneStart:11905,doneEnd:11905}
] as const;
const total=11905;

export function migrationDemoProgress(elapsedMs:number):MigrationProgress {
  const elapsed=Math.min(MIGRATION_DEMO_DURATION_MS,Math.max(0,Number.isFinite(elapsedMs)?elapsedMs:0));
  const phase=MIGRATION_DEMO_STEPS.find(step=>elapsed<step.end)??MIGRATION_DEMO_STEPS.at(-1)!;
  const ratio=Math.min(1,Math.max(0,(elapsed-phase.start)/(phase.end-phase.start)));
  const completed=Math.floor(phase.doneStart+(phase.doneEnd-phase.doneStart)*ratio);
  return {
    stage:phase.stage,from:'0.1.0',to:'0.2.0',
    completed,total,percent:Math.min(100,Math.floor(100*completed/total)),
    elapsedMs:elapsed,etaMs:elapsed>=MIGRATION_DEMO_DURATION_MS?null:MIGRATION_DEMO_DURATION_MS-elapsed
  };
}

export function migrationDemoFinished(elapsedMs:number):boolean{
  return elapsedMs>=MIGRATION_DEMO_DURATION_MS;
}
