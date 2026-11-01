export const DAILY_ARCHIVE_LIMIT = 100;
export function initializeDailyQuota(storage) {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS archive_daily (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL)');
}
export function consumeDailyQuota(storage, day, limit = DAILY_ARCHIVE_LIMIT) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(limit) || limit<1 || limit>10000) throw new Error('Invalid quota');
  return storage.transactionSync(() => {
    storage.sql.exec('DELETE FROM archive_daily WHERE day <> ?', day);
    storage.sql.exec('INSERT INTO archive_daily (day, attempts) VALUES (?, 0) ON CONFLICT(day) DO NOTHING',day);
    const used=Number(storage.sql.exec('SELECT attempts FROM archive_daily WHERE day = ?',day).one()?.attempts||0);
    if(used>=limit)return {allowed:false,used,limit};
    storage.sql.exec('UPDATE archive_daily SET attempts = attempts + 1 WHERE day = ?',day);
    return {allowed:true,used:used+1,limit};
  });
}