import { getDatabase } from '@/storage';

/** 读取 kv_meta 里的一个值；不存在时返回 null。 */
export function getMeta(key: string): string | null {
  const row = getDatabase().query('SELECT value FROM kv_meta WHERE key = ?').get(key) as { value: string } | null;
  return row ? row.value : null;
}

/** 写入（覆盖）kv_meta 里的一个值。 */
export function setMeta(key: string, value: string): void {
  getDatabase().run(
    'INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

/** 删除 kv_meta 里的一个值。 */
export function deleteMeta(key: string): void {
  getDatabase().run('DELETE FROM kv_meta WHERE key = ?', [key]);
}
