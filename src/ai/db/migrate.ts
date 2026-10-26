import type { Database } from 'bun:sqlite';

export type Migration = {
  version: number;
  name: string;
  up: (db: Database) => void;
};

export type MigrationResult = {
  /** 本次实际执行的版本号（升序） */
  applied: number[];
  /** 执行后数据库所处的最高版本 */
  current: number;
};

function assertWellFormed(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const m of sorted) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`迁移版本号必须是正整数: ${m.version} (${m.name})`);
    }
    if (seen.has(m.version)) {
      throw new Error(`迁移版本号重复: ${m.version}`);
    }
    seen.add(m.version);
  }
  return sorted;
}

/**
 * 按版本号升序执行尚未执行过的迁移。每个版本在独立事务里运行：
 * up() 抛错时该版本整体回滚、不记录，并把错误继续抛给调用方（后续版本不再执行）。
 * 已执行的版本记录在 schema_migrations 表里，重复调用是幂等的。
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): MigrationResult {
  const sorted = assertWellFormed(migrations);

  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`
  );

  const done = new Set(
    (db.query('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );
  const latestKnown = sorted.length > 0 ? sorted[sorted.length - 1].version : 0;
  const maxDone = done.size > 0 ? Math.max(...done) : 0;
  if (maxDone > latestKnown) {
    // 数据库被更新版本的程序迁移过（例如回滚了代码）：不尝试降级，只提示
    console.warn(`[DB] 数据库结构版本 v${maxDone} 高于当前程序已知的 v${latestKnown}，可能是回滚了代码`);
  }

  const applied: number[] = [];
  for (const m of sorted) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        Date.now(),
      ]);
    })();
    applied.push(m.version);
  }

  return { applied, current: Math.max(maxDone, ...applied, 0) };
}
