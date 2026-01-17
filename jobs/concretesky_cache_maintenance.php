<?php

namespace Concrete\Job;

use Concrete\Core\Job\Job;

defined('C5_EXECUTE') or die('Access Denied.');

class ConcreteskyCacheMaintenance extends Job
{
    public function getJobName()
    {
        return t('ConcreteSky: cache maintenance');
    }

    public function getJobDescription()
    {
        return t('Prune old ConcreteSky SQLite cache rows and run periodic VACUUM/ANALYZE to keep cache.sqlite bounded.');
    }

    protected function envInt(string $key, int $default, int $min, int $max): int
    {
        $raw = getenv($key);
        if ($raw === false || $raw === null || $raw === '') {
            return $default;
        }
        $n = (int)$raw;
        if ($n < $min) $n = $min;
        if ($n > $max) $n = $max;
        return $n;
    }

    protected function cacheDir(): string
    {
        $appDir = defined('DIR_APPLICATION')
            ? (string)DIR_APPLICATION
            : (defined('DIR_BASE') ? (rtrim((string)DIR_BASE, '/') . '/application') : (dirname(__DIR__, 3) . '/application'));

        $subdir = (string)(getenv('BSKY_STORAGE_SUBDIR') ?: 'concretesky');
        $subdir = trim($subdir, "/\t\n\r\0\x0B/");
        if ($subdir === '') $subdir = 'concretesky';

        $dir = rtrim($appDir, '/') . '/files/' . $subdir;

        // Back-compat: reuse legacy bluesky_feed dir when upgrading an existing install.
        if ($subdir === 'concretesky' && !is_dir($dir)) {
            $legacy = rtrim($appDir, '/') . '/files/bluesky_feed';
            if (is_dir($legacy)) return $legacy;
        }

        return $dir;
    }

    protected function cacheDbPath(): string
    {
        return $this->cacheDir() . '/cache.sqlite';
    }

    protected function metaGet(\PDO $pdo, string $k): ?string
    {
        try {
            $st = $pdo->prepare('SELECT v FROM meta WHERE k = :k LIMIT 1');
            $st->execute([':k' => $k]);
            $v = $st->fetchColumn();
            if ($v === false) return null;
            $v = (string)$v;
            return $v !== '' ? $v : null;
        } catch (\Throwable $e) {
            return null;
        }
    }

    protected function metaSet(\PDO $pdo, string $k, string $v): void
    {
        $st = $pdo->prepare('INSERT INTO meta(k, v, updated_at) VALUES(:k,:v,:u)
            ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at');
        $st->execute([':k' => $k, ':v' => $v, ':u' => gmdate('c')]);
    }

    public function run()
    {
        // Defaults are intentionally conservative.
        $keepDaysPosts = $this->envInt('CONCRETESKY_MAINT_KEEP_DAYS_POSTS', 365, 1, 3650);
        $keepDaysNotifs = $this->envInt('CONCRETESKY_MAINT_KEEP_DAYS_NOTIFS', 365, 1, 3650);
        $keepDaysOauth = $this->envInt('CONCRETESKY_MAINT_KEEP_DAYS_OAUTH', 14, 1, 3650);
        $vacuumDays = $this->envInt('CONCRETESKY_MAINT_VACUUM_DAYS', 7, 1, 3650);

        $path = $this->cacheDbPath();
        if (!is_file($path)) {
            return t('No cache database found (%s). Nothing to do.', $path);
        }

        if (!in_array('sqlite', \PDO::getAvailableDrivers(), true)) {
            return t('PDO SQLite driver missing (pdo_sqlite).');
        }

        $pdo = new \PDO('sqlite:' . $path);
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);

        // Keep SQLite settings aligned with the web runtime.
        try { $pdo->exec('PRAGMA journal_mode=WAL;'); } catch (\Throwable $e) { /* ignore */ }
        try { $pdo->exec('PRAGMA synchronous=NORMAL;'); } catch (\Throwable $e) { /* ignore */ }
        try { $pdo->exec('PRAGMA foreign_keys=ON;'); } catch (\Throwable $e) { /* ignore */ }

        // Ensure meta exists (we use it for last_vacuum_at).
        $pdo->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)');

        $cutPosts = gmdate('c', time() - ($keepDaysPosts * 86400));
        $cutNotifs = gmdate('c', time() - ($keepDaysNotifs * 86400));
        $cutOauth = gmdate('c', time() - ($keepDaysOauth * 86400));

        $deletedPosts = 0;
        $deletedNotifs = 0;
        $deletedOauth = 0;

        $pdo->beginTransaction();
        try {
            // Prune posts
            try {
                $st = $pdo->prepare('DELETE FROM posts WHERE created_at IS NOT NULL AND created_at < :cut');
                $st->execute([':cut' => $cutPosts]);
                $deletedPosts = (int)$st->rowCount();
            } catch (\Throwable $e) {
                $deletedPosts = 0;
            }

            // Prune notifications
            try {
                $st = $pdo->prepare('DELETE FROM notifications WHERE indexed_at IS NOT NULL AND indexed_at < :cut');
                $st->execute([':cut' => $cutNotifs]);
                $deletedNotifs = (int)$st->rowCount();
            } catch (\Throwable $e) {
                $deletedNotifs = 0;
            }

            // Prune OAuth state cache
            try {
                $st = $pdo->prepare('DELETE FROM oauth_states WHERE created_at IS NOT NULL AND created_at < :cut');
                $st->execute([':cut' => $cutOauth]);
                $deletedOauth = (int)$st->rowCount();
            } catch (\Throwable $e) {
                $deletedOauth = 0;
            }

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        // Decide whether to VACUUM.
        $doVacuum = false;
        $lastVacuumAt = $this->metaGet($pdo, 'last_vacuum_at');
        if ($lastVacuumAt) {
            try {
                $ts = (new \DateTimeImmutable($lastVacuumAt))->getTimestamp();
                $ageDays = (time() - $ts) / 86400;
                if ($ageDays >= $vacuumDays) $doVacuum = true;
            } catch (\Throwable $e) {
                $doVacuum = true;
            }
        } else {
            $doVacuum = true;
        }

        // If we freed a lot of rows, vacuum sooner.
        if (($deletedPosts + $deletedNotifs + $deletedOauth) > 1000) {
            $doVacuum = true;
        }

        $vacuumedAt = null;
        if ($doVacuum) {
            try { $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (\Throwable $e) { /* ignore */ }
            $pdo->exec('VACUUM;');
            try { $pdo->exec('ANALYZE;'); } catch (\Throwable $e) { /* ignore */ }
            $vacuumedAt = gmdate('c');
            $this->metaSet($pdo, 'last_vacuum_at', $vacuumedAt);
        }

        $msg = [];
        $msg[] = 'ConcreteSky cache maintenance:';
        $msg[] = "posts -{$deletedPosts} (keep {$keepDaysPosts}d)";
        $msg[] = "notifs -{$deletedNotifs} (keep {$keepDaysNotifs}d)";
        $msg[] = "oauth_states -{$deletedOauth} (keep {$keepDaysOauth}d)";
        $msg[] = $doVacuum ? ("VACUUM " . ($vacuumedAt ?: 'ok')) : ('VACUUM skipped');

        return implode(' • ', $msg);
    }
}
