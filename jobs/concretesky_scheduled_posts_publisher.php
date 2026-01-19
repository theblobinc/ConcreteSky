<?php

namespace Concrete\Job;

use Concrete\Core\Job\Job;
use Concrete\Core\Support\Facade\Facade;
use Concrete\Package\Concretesky\Controller\SinglePage\Concretesky\Api as ApiController;

defined('C5_EXECUTE') or die('Access Denied.');

class ConcreteskyScheduledPostsPublisher extends Job
{
    public function getJobName()
    {
        return t('ConcreteSky: scheduled posts publisher');
    }

    public function getJobDescription()
    {
        return t('Publish queued scheduled posts in the background, even when no browser tab is open.');
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
        $maxActors = $this->envInt('CONCRETESKY_SCHEDULED_JOB_MAX_ACTORS', 10, 1, 200);
        $maxPerActor = $this->envInt('CONCRETESKY_SCHEDULED_JOB_MAX_PER_ACTOR', 25, 1, 200);
        $lockSeconds = $this->envInt('CONCRETESKY_SCHEDULED_JOB_LOCK_SECONDS', 60, 10, 3600);

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

        // Ensure meta exists (we use it for a coarse job lock).
        $pdo->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)');

        $lockKey = '__global__:scheduled_posts_job_lock_until';
        $now = time();
        $nowIso = gmdate('c', $now);
        $staleIso = gmdate('c', $now - 600);

        $lockUntilIso = $this->metaGet($pdo, $lockKey);
        if ($lockUntilIso) {
            try {
                $lockUntilTs = (new \DateTimeImmutable($lockUntilIso))->getTimestamp();
                if ($lockUntilTs > $now) {
                    return 'ConcreteSky scheduled-posts job: locked until ' . $lockUntilIso;
                }
            } catch (\Throwable $e) {
                // ignore parse errors; we'll overwrite lock
            }
        }

        $this->metaSet($pdo, $lockKey, gmdate('c', $now + $lockSeconds));

        $actorsSeen = 0;
        $actorsProcessed = 0;
        $totalPosted = 0;
        $errors = 0;

        try {
            if (!class_exists(ApiController::class)) {
                return 'ConcreteSky scheduled-posts job: API controller not found (autoload failed?)';
            }

            $app = Facade::getFacadeApplication();
            /** @var ApiController $api */
            $api = $app->make(ApiController::class);

            $loadEnv = new \ReflectionMethod($api, 'loadDotEnvOnce');
            $loadEnv->setAccessible(true);
            $loadEnv->invoke($api);

            $cacheMigrate = new \ReflectionMethod($api, 'cacheMigrate');
            $cacheMigrate->setAccessible(true);
            $cacheMigrate->invoke($api, $pdo);

            $maybeRefresh = new \ReflectionMethod($api, 'maybeRefresh');
            $maybeRefresh->setAccessible(true);

            $process = new \ReflectionMethod($api, 'processScheduledPostsInternal');
            $process->setAccessible(true);

            $authUpsert = new \ReflectionMethod($api, 'authSessionUpsert');
            $authUpsert->setAccessible(true);

            $refApi = new \ReflectionClass($api);
            $pdsProp = $refApi->getProperty('pds');
            $pdsProp->setAccessible(true);

            // Pick actors with due work.
            $stActors = $pdo->prepare('SELECT actor_did, COUNT(*) AS due
                FROM scheduled_posts
                WHERE (
                    (state = "pending" AND scheduled_at <= :now AND (next_attempt_at IS NULL OR next_attempt_at <= :now))
                    OR (state = "posting" AND updated_at IS NOT NULL AND updated_at <= :stale)
                )
                GROUP BY actor_did
                ORDER BY MIN(scheduled_at) ASC
                LIMIT :lim');
            $stActors->bindValue(':now', $nowIso, \PDO::PARAM_STR);
            $stActors->bindValue(':stale', $staleIso, \PDO::PARAM_STR);
            $stActors->bindValue(':lim', $maxActors, \PDO::PARAM_INT);
            $stActors->execute();
            $actors = $stActors->fetchAll(\PDO::FETCH_ASSOC) ?: [];

            foreach ($actors as $row) {
                $actorsSeen++;
                $actorDid = trim((string)($row['actor_did'] ?? ''));
                if ($actorDid === '') continue;

                try {
                    $stSess = $pdo->prepare('SELECT c5_user_id, did, handle, pds, client_id, access_jwt, refresh_jwt, auth_type, auth_issuer,
                            dpop_private_pem, dpop_public_jwk, auth_dpop_nonce, resource_dpop_nonce, token_expires_at
                        FROM auth_sessions
                        WHERE did = :did
                        ORDER BY updated_at DESC
                        LIMIT 1');
                    $stSess->execute([':did' => $actorDid]);
                    $s = $stSess->fetch(\PDO::FETCH_ASSOC);

                    if (!$s || empty($s['access_jwt']) || empty($s['refresh_jwt'])) {
                        continue;
                    }

                    $c5UserId = (int)($s['c5_user_id'] ?? 0);
                    $pds = (string)($s['pds'] ?? '');
                    if ($pds === '') {
                        continue;
                    }

                    $session = [
                        'authType' => (string)($s['auth_type'] ?: 'password'),
                        'accessJwt' => (string)$s['access_jwt'],
                        'refreshJwt' => (string)$s['refresh_jwt'],
                        'did' => (string)$s['did'],
                        'handle' => (string)($s['handle'] ?? ''),
                        'pds' => $pds,
                        'clientId' => isset($s['client_id']) ? (string)$s['client_id'] : null,
                        'authIssuer' => isset($s['auth_issuer']) ? (string)$s['auth_issuer'] : null,
                        'dpopPrivatePem' => isset($s['dpop_private_pem']) ? (string)$s['dpop_private_pem'] : null,
                        'dpopPublicJwk' => !empty($s['dpop_public_jwk']) ? (json_decode((string)$s['dpop_public_jwk'], true) ?: null) : null,
                        'authDpopNonce' => isset($s['auth_dpop_nonce']) ? (string)$s['auth_dpop_nonce'] : null,
                        'resourceDpopNonce' => isset($s['resource_dpop_nonce']) ? (string)$s['resource_dpop_nonce'] : null,
                        'tokenExpiresAt' => isset($s['token_expires_at']) ? (string)$s['token_expires_at'] : null,
                    ];

                    // Per-user PDS.
                    $pdsProp->setValue($api, $pds);

                    // Refresh tokens if needed (and persist back into auth_sessions).
                    $session = $maybeRefresh->invoke($api, $session, $pdo, $c5UserId);

                    $out = $process->invokeArgs($api, [$pdo, &$session, $actorDid, $maxPerActor]);

                    // Persist updated nonces/tokens (OAuth nonce updates happen during XRPC calls).
                    $authUpsert->invoke($api, $pdo, $c5UserId, $session);

                    $actorsProcessed++;
                    $totalPosted += (int)($out['posted'] ?? 0);
                } catch (\Throwable $e) {
                    $errors++;
                    continue;
                }
            }

            $this->metaSet($pdo, '__global__:scheduled_posts_job_last_run_at', $nowIso);
        } catch (\Throwable $e) {
            $errors++;
        } finally {
            // Clear lock even if we errored.
            try { $this->metaSet($pdo, $lockKey, gmdate('c', $now - 1)); } catch (\Throwable $e) { /* ignore */ }
        }

        return 'ConcreteSky scheduled-posts job: actors ' . $actorsProcessed . '/' . $actorsSeen . ' • posted ' . $totalPosted . ' • errors ' . $errors;
    }
}
