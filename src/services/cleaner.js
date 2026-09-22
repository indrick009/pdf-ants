import { config } from '../config.js';
import { query } from '../db.js';
import { deletePrefix } from '../storage.js';

/**
 * Periodic cleanup: removes completed/failed exports older than EXPORT_TTL_HOURS
 * (DB rows + all objects in storage) so storage never fills up indefinitely.
 */
export async function cleanExpiredExports(log) {
  const { rows } = await query(
    `DELETE FROM exports
     WHERE status IN ('completed', 'failed')
       AND created_at < now() - make_interval(hours => $1)
     RETURNING id`,
    [config.exportTtlHours]
  );
  for (const row of rows) {
    try {
      await deletePrefix(`exports/${row.id}/`);
      log.info({ export_id: row.id }, 'expired export cleaned');
    } catch (err) {
      log.error({ export_id: row.id, err: err.message }, 'failed to clean export objects');
    }
  }
  return rows.length;
}

export function startCleaner(log) {
  const run = () =>
    cleanExpiredExports(log).catch((err) => log.error({ err: err.message }, 'cleaner failed'));
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
