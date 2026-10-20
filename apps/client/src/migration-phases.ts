/** Shared, stable phases for the real storage migration and its interactive preview. */
export const MIGRATION_PHASES=[
 '准备本地存储',
 '迁移操作记录',
 '校验 JSONL 日志',
 '检查旧版输出文件',
 '压缩 SQLite 数据库',
] as const;

export function migrationPhaseIndex(stage:string|undefined):number{
 if(!stage)return 0;
 if(stage.startsWith('已完成 '))return MIGRATION_PHASES.length;
 return MIGRATION_PHASES.findIndex(value=>value===stage);
}
