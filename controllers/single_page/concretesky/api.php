<?php
namespace Concrete\Package\Concretesky\Controller\SinglePage\Concretesky;

use Concrete\Package\Concretesky\Controller\SinglePage\Concretesky as ParentController; // parent with helpers: xrpc(), ensureSession(), createRecord(), deleteRecord(), listRecords()
use Concrete\Core\Support\Facade\Log;
use Concrete\Core\User\User;
use Concrete\Core\User\UserInfo;
use Concrete\Core\User\Login\LoginService;
use Symfony\Component\HttpFoundation\JsonResponse;

defined('C5_EXECUTE') or die('Access Denied.');

/**
 * Bluesky API passthrough for your front-end web components.
 * Highlights:
 * - CSRF + POST-only guard
 * - Session handling via parent BlueskyFeed helpers
 * - Chunking for endpoints that limit list size (e.g., actors<=25)
 * - Author feed "filter" passthrough (posts_with_replies, posts_no_replies, posts_with_media, ...)
 * - Thread fetch + inline reply support (createPost with reply)
 * - Bulk follow + time-filtered notifications
 */

class Api extends ParentController
{
    /**
     * Bump this when the cache schema/migration logic changes.
     * Stored in meta as __global__:schema_version so we can skip costly PRAGMA checks on every request.
     */
    protected const CACHE_SCHEMA_VERSION = '2026-01-19-1';

    protected static bool $envLoaded = false;

    protected function loadDotEnvOnce(): void
    {
        if (self::$envLoaded) return;
        self::$envLoaded = true;

        $root = defined('DIR_BASE') ? DIR_BASE : dirname(__DIR__, 6);
        $path = rtrim((string)$root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . '.env';
        if (!is_file($path) || !is_readable($path)) return;

        $lines = @file($path, FILE_IGNORE_NEW_LINES);
        if (!is_array($lines)) return;

        foreach ($lines as $line) {
            $line = trim((string)$line);
            if ($line === '' || str_starts_with($line, '#')) continue;
            $pos = strpos($line, '=');
            if ($pos === false) continue;

            $key = trim(substr($line, 0, $pos));
            $val = trim(substr($line, $pos + 1));
            if ($key === '') continue;

            // Strip surrounding quotes.
            if ((str_starts_with($val, '"') && str_ends_with($val, '"')) || (str_starts_with($val, "'") && str_ends_with($val, "'"))) {
                $val = substr($val, 1, -1);
            }

            // Don't override real env vars.
            if (getenv($key) !== false) continue;

            @putenv($key . '=' . $val);
            $_ENV[$key] = $val;
            $_SERVER[$key] = $val;
        }
    }

        protected function envBool(string $key, bool $default = false): bool
        {
            $v = getenv($key);
            if ($v === false) return $default;
            $s = strtolower(trim((string)$v));
            if ($s === '1' || $s === 'true' || $s === 'yes' || $s === 'on') return true;
            if ($s === '0' || $s === 'false' || $s === 'no' || $s === 'off') return false;
            return $default;
        }

        protected function envStr(string $key, string $default = ''): string
        {
            $v = getenv($key);
            return $v === false ? $default : (string)$v;
        }

        protected function envInt(string $key, int $default, int $min = PHP_INT_MIN, int $max = PHP_INT_MAX): int
        {
            $v = getenv($key);
            if ($v === false || $v === null || $v === '') return $default;
            $n = (int)$v;
            if ($n < $min) $n = $min;
            if ($n > $max) $n = $max;
            return $n;
        }

        protected function base64UrlEncode(string $bin): string
        {
            return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
        }

        protected function base64UrlDecode(string $s): ?string
        {
            $s = strtr((string)$s, '-_', '+/');
            $pad = strlen($s) % 4;
            if ($pad) $s .= str_repeat('=', 4 - $pad);
            $out = base64_decode($s, true);
            return ($out === false) ? null : $out;
        }

        protected function jwtSignHs256(string $data, string $secret): string
        {
            return hash_hmac('sha256', $data, $secret, true);
        }

        protected function jwtEncodeHs256(array $claims, string $secret): string
        {
            $hdr = ['alg' => 'HS256', 'typ' => 'JWT'];
            $h = $this->base64UrlEncode(json_encode($hdr, JSON_UNESCAPED_SLASHES));
            $p = $this->base64UrlEncode(json_encode($claims, JSON_UNESCAPED_SLASHES));
            $sig = $this->base64UrlEncode($this->jwtSignHs256($h . '.' . $p, $secret));
            return $h . '.' . $p . '.' . $sig;
        }

        protected function jwtDecodeHs256(string $token, string $secret): array
        {
            $parts = explode('.', $token);
            if (count($parts) !== 3) return ['ok' => false, 'error' => 'Malformed JWT'];
            [$h64, $p64, $s64] = $parts;

            $hdrJson = $this->base64UrlDecode($h64);
            $plJson  = $this->base64UrlDecode($p64);
            $sigBin  = $this->base64UrlDecode($s64);
            if ($hdrJson === null || $plJson === null || $sigBin === null) return ['ok' => false, 'error' => 'Malformed JWT'];

            $hdr = json_decode($hdrJson, true);
            $pl  = json_decode($plJson, true);
            if (!is_array($hdr) || !is_array($pl)) return ['ok' => false, 'error' => 'Malformed JWT'];

            $alg = (string)($hdr['alg'] ?? '');
            if ($alg !== 'HS256') return ['ok' => false, 'error' => 'Unsupported JWT alg'];

            $expect = $this->jwtSignHs256($h64 . '.' . $p64, $secret);
            if (!hash_equals($expect, $sigBin)) return ['ok' => false, 'error' => 'Bad JWT signature'];

            $now = time();
            if (isset($pl['nbf']) && is_numeric($pl['nbf']) && (int)$pl['nbf'] > $now) return ['ok' => false, 'error' => 'JWT not active'];
            if (isset($pl['iat']) && is_numeric($pl['iat']) && (int)$pl['iat'] > $now + 60) return ['ok' => false, 'error' => 'JWT iat in future'];
            if (!isset($pl['exp']) || !is_numeric($pl['exp'])) return ['ok' => false, 'error' => 'JWT missing exp'];
            if ((int)$pl['exp'] <= $now) return ['ok' => false, 'error' => 'JWT expired'];

            return ['ok' => true, 'claims' => $pl];
        }

        protected function getBearerToken(): ?string
        {
            $h = (string)($this->request->headers->get('Authorization') ?: '');
            if (!$h) return null;
            if (preg_match('/^Bearer\s+(.+)$/i', $h, $m)) {
                return trim((string)$m[1]);
            }
            return null;
        }

        protected function jwtTryAuthenticate(): array
        {
            $this->loadDotEnvOnce();

            $enabled = $this->envBool('CONCRETESKY_JWT_ENABLED', false);
            $token = $this->getBearerToken();

            if (!$enabled) {
                return ['enabled' => false, 'tokenProvided' => (bool)$token, 'ok' => false];
            }
            if (!$token) {
                return ['enabled' => true, 'tokenProvided' => false, 'ok' => false];
            }

            $secret = (string)$this->envStr('CONCRETESKY_JWT_SECRET', '');
            if (strlen($secret) < 16) {
                return ['enabled' => true, 'tokenProvided' => true, 'ok' => false, 'error' => 'JWT secret not configured'];
            }

            $decoded = $this->jwtDecodeHs256($token, $secret);
            if (empty($decoded['ok'])) {
                return ['enabled' => true, 'tokenProvided' => true, 'ok' => false, 'error' => (string)($decoded['error'] ?? 'Bad JWT')];
            }

            $claims = (array)($decoded['claims'] ?? []);
            $sub = (string)($claims['sub'] ?? '');
            if ($sub === '') {
                return ['enabled' => true, 'tokenProvided' => true, 'ok' => false, 'error' => 'JWT missing sub'];
            }

            $usersRaw = trim((string)$this->envStr('CONCRETESKY_JWT_USERS', ''));
            if ($usersRaw === '') {
                $usersRaw = trim((string)$this->envStr('CONCRETESKY_JWT_USER', ''));
            }
            $allowed = array_values(array_filter(array_map('trim', explode(',', $usersRaw))));
            if (!$allowed) {
                return ['enabled' => true, 'tokenProvided' => true, 'ok' => false, 'error' => 'JWT allowed users not configured'];
            }
            if (!in_array($sub, $allowed, true)) {
                return ['enabled' => true, 'tokenProvided' => true, 'ok' => false, 'error' => 'JWT user not allowed'];
            }

            $ui = UserInfo::getByUserName($sub);
            if (!$ui) {
                return ['enabled' => true, 'tokenProvided' => true, 'ok' => false, 'error' => 'JWT user not found'];
            }

            $requireSuper = $this->envBool('CONCRETESKY_JWT_REQUIRE_SUPERUSER', true);
            $isSuper = method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
            if ($requireSuper && !$isSuper) {
                return ['enabled' => true, 'tokenProvided' => true, 'ok' => false, 'error' => 'JWT user must be super user'];
            }

            return [
                'enabled' => true,
                'tokenProvided' => true,
                'ok' => true,
                'userId' => (int)$ui->getUserID(),
                'userName' => (string)$ui->getUserName(),
                'isSuper' => $isSuper,
                'claims' => $claims,
            ];
        }

        protected function requireSuperUser(array $jwt = []): void
        {
            // Allow superuser JWT automation to perform admin-only maintenance.
            if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                return;
            }

            $u = new User();
            if (!$u->isRegistered()) {
                throw new \RuntimeException('ConcreteCMS login required', 401);
            }

            $ui = UserInfo::getByID((int)$u->getUserID());
            if (!$ui) {
                throw new \RuntimeException('ConcreteCMS user not found', 401);
            }

            $isSuper = method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
            if (!$isSuper) {
                throw new \RuntimeException('Super user required', 403);
            }
        }

    protected function cacheSyncMyPosts(\PDO $pdo, array &$session, string $actorDid, int $hours = 24, int $pagesMax = 25, ?string $filter = null): array
    {
        $cutoffTs = time() - ($hours * 3600);

        // If we've synced before, stop once we reach the last seen timestamp.
        $lastSeenIso = $this->cacheMetaGet($pdo, $actorDid, 'last_posts_seen_at');
        $lastSeenTs = $lastSeenIso ? strtotime($lastSeenIso) : null;
        if ($lastSeenTs && $lastSeenTs > $cutoffTs) $cutoffTs = $lastSeenTs;

        $pages = 0;
        $inserted = 0;
        $updated = 0;
        $skipped = 0;
        $stoppedEarly = false;
        $maxSeenTs = null;
        $minSeenTs = null;

        $cursor = null;

        // Prepared statement for upsert.
        $stmtUpsert = $pdo->prepare(
            'INSERT INTO posts(actor_did, uri, cid, created_at, indexed_at, kind, text, raw_json, updated_at) '
            . 'VALUES(:actor_did, :uri, :cid, :created_at, :indexed_at, :kind, :text, :raw_json, :updated_at) '
            . 'ON CONFLICT(actor_did, uri) DO UPDATE SET '
            . '  cid=excluded.cid, '
            . '  created_at=excluded.created_at, '
            . '  indexed_at=excluded.indexed_at, '
            . '  kind=excluded.kind, '
            . '  text=excluded.text, '
            . '  raw_json=excluded.raw_json, '
            . '  updated_at=excluded.updated_at'
        );

        $stmtExists = $pdo->prepare('SELECT 1 FROM posts WHERE actor_did = :actor_did AND uri = :uri LIMIT 1');

        while ($pages < $pagesMax) {
            $pages++;
            $resp = $this->xrpcSession('GET', 'app.bsky.feed.getAuthorFeed', $session, [
                'actor' => $actorDid,
                'limit' => 100,
                'cursor' => $cursor,
                // Allow caller to override filter; null -> default server behavior.
                'filter' => $filter,
            ]);

            $feed = $resp['feed'] ?? [];
            if (!$feed) break;

            foreach ($feed as $item) {
                $createdAt = $item['post']['record']['createdAt'] ?? null;
                $createdTs = $createdAt ? strtotime($createdAt) : null;

                // Keep track of newest timestamp seen in this run.
                if ($createdTs) {
                    if ($maxSeenTs === null || $createdTs > $maxSeenTs) $maxSeenTs = $createdTs;
                }

                // Stop once we hit items older than the cutoff.
                if ($createdTs && $createdTs <= $cutoffTs) {
                    $stoppedEarly = true;
                    break 2;
                }

                $uri = $item['post']['uri'] ?? null;
                if (!$uri) { $skipped++; continue; }

                $cid = $item['post']['cid'] ?? null;
                $indexedAt = $item['post']['indexedAt'] ?? null;
                $kind = $this->postKindFromFeedItem($item);
                $text = $this->postTextFromFeedItem($item);

                // Determine if this is insert vs update.
                $stmtExists->execute([':actor_did' => $actorDid, ':uri' => $uri]);
                $had = (bool)$stmtExists->fetchColumn();

                $stmtUpsert->execute([
                    ':actor_did' => $actorDid,
                    ':uri' => $uri,
                    ':cid' => $cid,
                    ':created_at' => $createdAt,
                    ':indexed_at' => $indexedAt,
                    ':kind' => $kind,
                    ':text' => $text,
                    ':raw_json' => json_encode($item, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                    ':updated_at' => gmdate('c'),
                ]);

                if ($had) $updated++; else $inserted++;
            }

            $cursor = $resp['cursor'] ?? null;
            if (!$cursor) break;
        }

        // Advance the "last seen" timestamp to the newest post timestamp observed.
        // Using "now" here would incorrectly stop all future syncs.
        if ($maxSeenTs !== null) {
            $prev = $lastSeenTs ?: 0;
            if ($maxSeenTs > $prev) {
                $this->cacheMetaSet($pdo, $actorDid, 'last_posts_seen_at', gmdate('c', $maxSeenTs));
            }
        }

        // Optional pruning of very old rows for this actor.
        // Default is NO pruning so we can retain full history when desired.
        $pruned = 0;
        $retentionDays = (int)(getenv('BSKY_POST_RETENTION_DAYS') ?: 0);
        if ($retentionDays > 0) {
            $stmtPrune = $pdo->prepare('DELETE FROM posts WHERE actor_did = :actor_did AND created_at < :cutoff');
            $stmtPrune->execute([':actor_did' => $actorDid, ':cutoff' => gmdate('c', time() - ($retentionDays * 86400))]);
            $pruned = $stmtPrune->rowCount();
        }

        return [
            'actorDid' => $actorDid,
            'hours' => $hours,
            'pages' => $pages,
            'inserted' => $inserted,
            'updated' => $updated,
            'skipped' => $skipped,
            'stoppedEarly' => $stoppedEarly,
            'pruned' => $pruned,
            'cutoffIso' => gmdate('c', $cutoffTs),
        ];
    }

    protected function cacheBackfillMyPosts(\PDO $pdo, array &$session, string $actorDid, int $pagesMax = 25, ?string $filter = null, bool $reset = false, ?string $stopBeforeIso = null): array
    {
        if ($reset) {
            $this->cacheMetaSet($pdo, $actorDid, 'posts_backfill_done', '');
            $this->cacheMetaSet($pdo, $actorDid, 'posts_backfill_cursor', '');
        }

        $stopBeforeTs = $stopBeforeIso ? strtotime($stopBeforeIso) : null;

        $done = $this->cacheMetaGet($pdo, $actorDid, 'posts_backfill_done');
        if ($done === '1') {
            return ['actorDid' => $actorDid, 'pages' => 0, 'inserted' => 0, 'updated' => 0, 'skipped' => 0, 'cursor' => null, 'done' => true];
        }

        $cursor = $this->cacheMetaGet($pdo, $actorDid, 'posts_backfill_cursor');
        if ($cursor === '') $cursor = null;

        $pages = 0;
        $inserted = 0;
        $updated = 0;
        $skipped = 0;
        $stoppedEarly = false;

        $stmtUpsert = $pdo->prepare(
            'INSERT INTO posts(actor_did, uri, cid, created_at, indexed_at, kind, text, raw_json, updated_at) '
            . 'VALUES(:actor_did, :uri, :cid, :created_at, :indexed_at, :kind, :text, :raw_json, :updated_at) '
            . 'ON CONFLICT(actor_did, uri) DO UPDATE SET '
            . '  cid=excluded.cid, '
            . '  created_at=excluded.created_at, '
            . '  indexed_at=excluded.indexed_at, '
            . '  kind=excluded.kind, '
            . '  text=excluded.text, '
            . '  raw_json=excluded.raw_json, '
            . '  updated_at=excluded.updated_at'
        );
        $stmtExists = $pdo->prepare('SELECT 1 FROM posts WHERE actor_did = :actor_did AND uri = :uri LIMIT 1');

        while ($pages < $pagesMax) {
            $pages++;
            $resp = $this->xrpcSession('GET', 'app.bsky.feed.getAuthorFeed', $session, [
                'actor' => $actorDid,
                'limit' => 100,
                'cursor' => $cursor,
                'filter' => $filter,
            ]);

            $feed = $resp['feed'] ?? [];
            if (!$feed) {
                $cursor = null;
                break;
            }

            foreach ($feed as $item) {
                $uri = $item['post']['uri'] ?? null;
                if (!$uri) { $skipped++; continue; }

                $createdAt = $item['post']['record']['createdAt'] ?? null;
                $cid = $item['post']['cid'] ?? null;
                $indexedAt = $item['post']['indexedAt'] ?? null;
                $kind = $this->postKindFromFeedItem($item);
                $text = $this->postTextFromFeedItem($item);

                $stmtExists->execute([':actor_did' => $actorDid, ':uri' => $uri]);
                $had = (bool)$stmtExists->fetchColumn();

                $stmtUpsert->execute([
                    ':actor_did' => $actorDid,
                    ':uri' => $uri,
                    ':cid' => $cid,
                    ':created_at' => $createdAt,
                    ':indexed_at' => $indexedAt,
                    ':kind' => $kind,
                    ':text' => $text,
                    ':raw_json' => json_encode($item, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                    ':updated_at' => gmdate('c'),
                ]);

                if ($had) $updated++; else $inserted++;
            }

            // Optional stop: if we've paged back past the selected day, stop.
            // (This allows the UI to fetch a specific range without forcing a full-history import.)
            if ($stopBeforeTs) {
                try {
                    $last = $feed[count($feed) - 1] ?? null;
                    $lastIso = $last['post']['record']['createdAt'] ?? null;
                    if ($lastIso) {
                        $lastTs = strtotime((string)$lastIso);
                        if ($lastTs && $lastTs <= $stopBeforeTs) {
                            $stoppedEarly = true;
                            break;
                        }
                    }
                } catch (\Throwable $e) {
                    // ignore
                }
            }

            $cursor = $resp['cursor'] ?? null;
            if (!$cursor) break;
        }

        if ($cursor) {
            $this->cacheMetaSet($pdo, $actorDid, 'posts_backfill_cursor', (string)$cursor);
            $this->cacheMetaSet($pdo, $actorDid, 'posts_backfill_done', '');
            return ['actorDid' => $actorDid, 'pages' => $pages, 'inserted' => $inserted, 'updated' => $updated, 'skipped' => $skipped, 'cursor' => (string)$cursor, 'done' => false, 'stoppedEarly' => $stoppedEarly, 'stopBeforeIso' => $stopBeforeIso];
        }

        $this->cacheMetaSet($pdo, $actorDid, 'posts_backfill_cursor', '');
        $this->cacheMetaSet($pdo, $actorDid, 'posts_backfill_done', '1');
        return ['actorDid' => $actorDid, 'pages' => $pages, 'inserted' => $inserted, 'updated' => $updated, 'skipped' => $skipped, 'cursor' => null, 'done' => true, 'stoppedEarly' => $stoppedEarly, 'stopBeforeIso' => $stopBeforeIso];
    }

    protected function cacheQueryMyPosts(\PDO $pdo, string $actorDid, ?string $sinceIso, ?string $untilIso, int $hours, array $types, int $limit, int $offset, bool $newestFirst): array
    {
        $cutoffIso = $hours > 0 ? gmdate('c', time() - ($hours * 3600)) : null;

        $where = ['actor_did = :actor_did'];
        $bind = [':actor_did' => $actorDid];

        if ($sinceIso) {
            $where[] = 'created_at >= :since';
            $bind[':since'] = $sinceIso;
        } elseif ($cutoffIso) {
            $where[] = 'created_at >= :cutoff';
            $bind[':cutoff'] = $cutoffIso;
        }

        if ($untilIso) {
            $where[] = 'created_at <= :until';
            $bind[':until'] = $untilIso;
        }

        if ($types) {
            $in = [];
            foreach ($types as $i => $t) {
                $k = ':t' . $i;
                $in[] = $k;
                $bind[$k] = $t;
            }
            $where[] = 'kind IN (' . implode(',', $in) . ')';
        }

        // Total count (for UI counters). Must reuse the exact same filters as the item query.
        $sqlTotal = 'SELECT COUNT(1) FROM posts WHERE ' . implode(' AND ', $where);
        $stmtTotal = $pdo->prepare($sqlTotal);
        foreach ($bind as $k => $v) $stmtTotal->bindValue($k, $v);
        $stmtTotal->execute();
        $total = (int)$stmtTotal->fetchColumn();

        $order = $newestFirst ? 'DESC' : 'ASC';
        $sql = 'SELECT uri, cid, created_at, indexed_at, kind, raw_json '
            . 'FROM posts '
            . 'WHERE ' . implode(' AND ', $where) . ' '
            . 'ORDER BY created_at ' . $order . ', uri ' . $order . ' '
            . 'LIMIT :limit OFFSET :offset';

        $stmt = $pdo->prepare($sql);
        foreach ($bind as $k => $v) $stmt->bindValue($k, $v);
        $stmt->bindValue(':limit', $limit, \PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, \PDO::PARAM_INT);
        $stmt->execute();

        $items = [];
        while ($row = $stmt->fetch(\PDO::FETCH_ASSOC)) {
            $raw = $row['raw_json'] ? json_decode($row['raw_json'], true) : null;
            if ($raw) $items[] = $raw;
        }

        // Provide a cheap hasMore hint.
        // Must reuse the exact same filters (types + since/until) to avoid lying to the client.
        $sqlMore = 'SELECT 1 FROM posts WHERE ' . implode(' AND ', $where) . ' LIMIT 1 OFFSET :off';
        $stmtMore = $pdo->prepare($sqlMore);
        foreach ($bind as $k => $v) $stmtMore->bindValue($k, $v);
        $stmtMore->bindValue(':off', $offset + $limit, \PDO::PARAM_INT);
        $stmtMore->execute();
        $hasMore = (bool)$stmtMore->fetchColumn();

        return [
            'actorDid' => $actorDid,
            'since' => $sinceIso,
            'until' => $untilIso,
            'cutoffIso' => $sinceIso ?: $cutoffIso,
            'total' => $total,
            'limit' => $limit,
            'offset' => $offset,
            'newestFirst' => $newestFirst,
            'types' => $types,
            'items' => $items,
            'hasMore' => $hasMore,
        ];
    }

    protected function postKindFromFeedItem(array $item): string
    {
        $reply = $item['post']['record']['reply'] ?? null;
        $embed = $item['post']['embed'] ?? null;

        if ($reply) return 'reply';

        // Reposts show up as "reason".
        if (isset($item['reason']['$type']) && str_contains((string)$item['reason']['$type'], 'Repost')) return 'repost';

        if (is_array($embed) && isset($embed['$type'])) {
            $t = (string)$embed['$type'];
            if (str_contains($t, 'embed.images')) return 'image';
            if (str_contains($t, 'embed.external')) return 'external';
            if (str_contains($t, 'embed.recordWithMedia')) return 'recordWithMedia';
            if (str_contains($t, 'embed.record')) return 'record';
            if (str_contains($t, 'embed.video')) return 'video';
        }

        return 'post';
    }

    protected function postTextFromFeedItem(array $item): string
    {
        try {
            $text = (string)($item['post']['record']['text'] ?? '');
            $text = trim((string)preg_replace('/\s+/', ' ', $text));
            if (strlen($text) > 5000) $text = substr($text, 0, 5000);
            return $text;
        } catch (\Throwable $e) {
            return '';
        }
    }

    protected function normalizeActorInput(string $actor): string
    {
        $actor = trim($actor);
        if ($actor === '') return '';
        if (str_starts_with($actor, '@')) $actor = substr($actor, 1);
        return trim($actor);
    }

    protected function resolveActorDid(array &$session, string $actorOrDid): string
    {
        $actorOrDid = $this->normalizeActorInput($actorOrDid);
        if ($actorOrDid === '') {
            throw new \RuntimeException('Missing actor', 400);
        }
        if (str_starts_with($actorOrDid, 'did:')) {
            return $actorOrDid;
        }

        $resp = $this->xrpcSession('GET', 'com.atproto.identity.resolveHandle', $session, [
            'handle' => $actorOrDid,
        ]);
        $did = (string)($resp['did'] ?? '');
        if ($did === '') {
            throw new \RuntimeException('Could not resolve handle to DID', 400);
        }
        return $did;
    }

    public function view()
    {
        $jwt = $this->jwtTryAuthenticate();

        // --- Method + CSRF guards ---
        if (strtoupper($this->request->getMethod()) !== 'POST') {
            return $this->json(['error' => 'Method Not Allowed'], 405);
        }
        // Optional JWT auth for automation/MCP.
        // If a token is provided and invalid, fail fast with a JWT-specific error.
        if (!empty($jwt['enabled']) && !empty($jwt['tokenProvided']) && empty($jwt['ok'])) {
            return $this->json(['error' => 'Bad JWT', 'detail' => (string)($jwt['error'] ?? '')], 403);
        }

        $enforceJwt = $this->envBool('CONCRETESKY_JWT_ENFORCE', false);
        if ($enforceJwt && empty($jwt['ok'])) {
            return $this->json(['error' => 'JWT required'], 401);
        }

        // Default browser flow: require CSRF unless a valid JWT is present.
        if (empty($jwt['ok'])) {
            $token = app('token');
            if (!$token->validate('bsky_api', $this->request->headers->get('X-CSRF-Token'))) {
                return $this->json(['error' => 'Bad CSRF'], 403);
            }
        }

        // --- Decode request payload ---
        $body   = json_decode($this->request->getContent() ?: '{}', true) ?: [];
        $method = $body['method'] ?? '';
        $params = $body['params'] ?? [];

        if ($this->debug) {
            Log::debug('[BSKY api] method=' . $method . ' params=' . json_encode($params));
        }

        try {
            // Auth endpoints are allowed even when not connected yet.
            if ($method === 'authStatus') {
                if (!empty($jwt['ok'])) {
                    $registered = true;
                    $c5UserId = (int)$jwt['userId'];
                    $c5UserName = (string)$jwt['userName'];
                } else {
                    $u = new User();
                    $registered = (bool)$u->isRegistered();
                    $c5UserId = (int)$u->getUserID();
                    $c5UserName = $registered ? (string)$u->getUserName() : 'Guest';
                }

                $out = [
                    'ok' => true,
                    'c5' => [
                        'registered' => $registered,
                        'userId' => $c5UserId,
                            'userName' => $c5UserName,
                    ],
                    'connected' => false,
                    'did' => null,
                    'handle' => null,
                    'pds' => null,
                    'updatedAt' => null,
                    'cacheAvailable' => null,
                    'cacheError' => null,
                ];

                // Guests can see status (always disconnected) but cannot store sessions.
                if (!$registered || $c5UserId <= 0) {
                    return $this->json($out);
                }

                try {
                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $out['cacheAvailable'] = true;

                    $row = $this->authSessionGet($pdo, $c5UserId);
                    $accounts = $this->authSessionsList($pdo, $c5UserId);

                    $out['connected'] = (bool)($row && !empty($row['did']) && !empty($row['access_jwt']) && !empty($row['refresh_jwt']));
                    $out['did'] = $row['did'] ?? null;
                    $out['handle'] = $row['handle'] ?? null;
                    $out['displayName'] = $row['display_name'] ?? null;
                    $out['avatar'] = $row['avatar'] ?? null;
                    $out['pds'] = $row['pds'] ?? null;
                    $out['updatedAt'] = $row['updated_at'] ?? null;
                    $out['activeDid'] = $this->authActiveDidGet($pdo, $c5UserId);
                    $out['accounts'] = array_map(static function ($a) {
                        return [
                            'did' => $a['did'] ?? null,
                            'handle' => $a['handle'] ?? null,
                            'displayName' => $a['display_name'] ?? null,
                            'avatar' => $a['avatar'] ?? null,
                            'pds' => $a['pds'] ?? null,
                            'authType' => $a['auth_type'] ?? null,
                            'accountCreatedAt' => $a['account_created_at'] ?? null,
                            'updatedAt' => $a['updated_at'] ?? null,
                        ];
                    }, $accounts);
                } catch (\Throwable $e) {
                    // Cache DB is optional for status; don't hard-fail the whole UI.
                    $out['cacheAvailable'] = false;
                    $out['cacheError'] = $e->getMessage();
                    $out['connected'] = false;
                    $out['accounts'] = [];
                }
                return $this->json($out);
            }

            // MCP/automation helper: convert a valid JWT into a ConcreteCMS logged-in session cookie.
            // This is intentionally OFF by default and should only be enabled in controlled environments.
            if ($method === 'mcpLogin') {
                $this->loadDotEnvOnce();

                if (!$this->envBool('CONCRETESKY_MCP_LOGIN_ENABLED', false)) {
                    return $this->json(['error' => 'Not Found'], 404);
                }
                if (empty($jwt['ok'])) {
                    return $this->json(['error' => 'JWT required'], 401);
                }

                $targetUserName = trim((string)($params['userName'] ?? ''));
                if ($targetUserName === '') {
                    $targetUserName = (string)$jwt['userName'];
                }

                // Impersonation is opt-in (separate from JWT allowlist).
                $impersonating = ($targetUserName !== (string)$jwt['userName']);
                if ($impersonating) {
                    if (!$this->envBool('CONCRETESKY_MCP_LOGIN_ALLOW_IMPERSONATE', false)) {
                        return $this->json(['error' => 'Impersonation disabled'], 403);
                    }
                    if (empty($jwt['isSuper'])) {
                        return $this->json(['error' => 'JWT user must be super user'], 403);
                    }
                }

                $ui = UserInfo::getByUserName($targetUserName);
                if (!$ui) {
                    return $this->json(['error' => 'User not found'], 404);
                }
                if (method_exists($ui, 'isActive') && !$ui->isActive()) {
                    return $this->json(['error' => 'User inactive'], 403);
                }
                if (method_exists($ui, 'isValidated') && !$ui->isValidated()) {
                    return $this->json(['error' => 'User not validated'], 403);
                }

                // If the UI is restricted, only allow logging in as a user who would be allowed to use it.
                try {
                    $this->requireUiAccess($ui);
                } catch (\Throwable $e) {
                    return $this->json(['error' => 'Forbidden'], 403);
                }

                /** @var LoginService $login */
                $login = app(LoginService::class);
                $login->loginByUserID((int)$ui->getUserID());

                // Note: the session cookie is written in the response; the current request won't reliably
                // reflect the new session user when we instantiate Concrete\Core\User\User.
                return $this->json([
                    'ok' => true,
                    'impersonating' => $impersonating,
                    'jwtUserName' => (string)$jwt['userName'],
                    'c5' => [
                        'registered' => true,
                        'userId' => (int)$ui->getUserID(),
                        'userName' => (string)$ui->getUserName(),
                    ],
                ]);
            }

            // For all other methods, require a logged-in Concrete user (or a valid JWT user)
            // AND apply the same access guard used for the SPA.
            try {
                if (!empty($jwt['ok'])) {
                    $callerUi = UserInfo::getByID((int)$jwt['userId']);
                    $this->requireUiAccess($callerUi);
                } else {
                    $u = new User();
                    if (!$u->isRegistered()) {
                        return $this->json(['error' => 'ConcreteCMS login required'], 401);
                    }
                    $callerUi = UserInfo::getByID((int)$u->getUserID());
                    $this->requireUiAccess($callerUi);
                }
            } catch (\Throwable $e) {
                return $this->json(['error' => 'Forbidden'], 403);
            }

            // ConcreteCMS user must be logged in for all other API calls.
                $c5UserId = !empty($jwt['ok']) ? (int)$jwt['userId'] : $this->requireConcreteUserId();

            if ($method === 'authLogout') {
                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);
                $activeDid = $this->authActiveDidGet($pdo, $c5UserId);
                if ($activeDid) {
                    $this->authSessionDelete($pdo, $c5UserId, $activeDid);
                }
                $this->authActiveDidClear($pdo, $c5UserId);

                // If other sessions exist, pick the most recent as new active.
                $row = $this->authSessionGet($pdo, $c5UserId);
                $connected = (bool)($row && !empty($row['did']) && !empty($row['access_jwt']) && !empty($row['refresh_jwt']));
                return $this->json([
                    'ok' => true,
                    'connected' => $connected,
                    'did' => $row['did'] ?? null,
                    'handle' => $row['handle'] ?? null,
                    'pds' => $row['pds'] ?? null,
                ]);
            }

            if ($method === 'authLogoutAll') {
                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);
                $this->authSessionDelete($pdo, $c5UserId, null);
                $this->authActiveDidClear($pdo, $c5UserId);
                return $this->json(['ok' => true, 'connected' => false]);
            }

            if ($method === 'accountsList') {
                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);
                $accounts = $this->authSessionsList($pdo, $c5UserId);
                return $this->json([
                    'ok' => true,
                    'activeDid' => $this->authActiveDidGet($pdo, $c5UserId),
                    'accounts' => array_map(static function ($a) {
                        return [
                            'did' => $a['did'] ?? null,
                            'handle' => $a['handle'] ?? null,
                            'displayName' => $a['display_name'] ?? null,
                            'avatar' => $a['avatar'] ?? null,
                            'pds' => $a['pds'] ?? null,
                            'authType' => $a['auth_type'] ?? null,
                            'accountCreatedAt' => $a['account_created_at'] ?? null,
                            'updatedAt' => $a['updated_at'] ?? null,
                        ];
                    }, $accounts),
                ]);
            }

            if ($method === 'accountsSetActive') {
                $did = isset($params['did']) ? (string)$params['did'] : '';
                if ($did === '') return $this->json(['error' => 'Missing did'], 400);

                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);

                // Ensure the account exists.
                $st = $pdo->prepare('SELECT did FROM auth_sessions WHERE c5_user_id = :u AND did = :did LIMIT 1');
                $st->execute([':u' => $c5UserId, ':did' => $did]);
                $have = $st->fetchColumn();
                if ($have === false) return $this->json(['error' => 'Account not found'], 404);

                $this->authActiveDidSet($pdo, $c5UserId, $did);
                // Return fresh auth status (active account).
                $row = $this->authSessionGet($pdo, $c5UserId);
                return $this->json([
                    'ok' => true,
                    'connected' => (bool)($row && !empty($row['did']) && !empty($row['access_jwt']) && !empty($row['refresh_jwt'])),
                    'did' => $row['did'] ?? null,
                    'handle' => $row['handle'] ?? null,
                    'displayName' => $row['display_name'] ?? null,
                    'avatar' => $row['avatar'] ?? null,
                    'pds' => $row['pds'] ?? null,
                    'activeDid' => $this->authActiveDidGet($pdo, $c5UserId),
                ]);
            }

            if ($method === 'accountsRemove') {
                $did = isset($params['did']) ? (string)$params['did'] : '';
                if ($did === '') return $this->json(['error' => 'Missing did'], 400);

                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);

                $this->authSessionDelete($pdo, $c5UserId, $did);
                $activeDid = $this->authActiveDidGet($pdo, $c5UserId);
                if ($activeDid === $did) {
                    $this->authActiveDidClear($pdo, $c5UserId);
                    // pick a replacement if possible
                    $this->authSessionGet($pdo, $c5UserId);
                }

                return $this->json(['ok' => true]);
            }

            if ($method === 'profilesBackfillAccounts') {
                $max = isset($params['max']) ? (int)$params['max'] : 12;
                if ($max < 1) $max = 1;
                if ($max > 50) $max = 50;

                $staleHours = isset($params['staleHours']) ? (int)$params['staleHours'] : 24;
                if ($staleHours < 1) $staleHours = 1;
                if ($staleHours > (24 * 30)) $staleHours = 24 * 30;
                $staleCutoffTs = time() - ($staleHours * 3600);

                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);

                $accounts = $this->authSessionsList($pdo, $c5UserId);
                if (!$accounts) {
                    return $this->json(['ok' => true, 'updated' => 0, 'skipped' => 0, 'errors' => 0]);
                }

                $stProfileUpdated = $pdo->prepare('SELECT updated_at FROM profiles WHERE did = :did LIMIT 1');
                $stSession = $pdo->prepare('SELECT did, handle, pds, access_jwt, refresh_jwt, auth_type, auth_issuer, dpop_private_pem, dpop_public_jwk, auth_dpop_nonce, resource_dpop_nonce, token_expires_at FROM auth_sessions WHERE c5_user_id = :u AND did = :did LIMIT 1');

                $updated = 0;
                $skipped = 0;
                $errors = 0;

                $prevPds = $this->pds;
                try {
                    foreach ($accounts as $a) {
                        if ($updated >= $max) break;
                        $did = isset($a['did']) ? (string)$a['did'] : '';
                        if ($did === '') continue;

                        // Skip if cached profile is fresh enough.
                        $stProfileUpdated->execute([':did' => $did]);
                        $pUpdatedAt = $stProfileUpdated->fetchColumn();
                        $pUpdatedTs = $pUpdatedAt ? strtotime((string)$pUpdatedAt) : null;
                        if ($pUpdatedTs && $pUpdatedTs >= $staleCutoffTs) {
                            $skipped++;
                            continue;
                        }

                        // Load full session material for this DID.
                        $stSession->execute([':u' => $c5UserId, ':did' => $did]);
                        $row = $stSession->fetch(\PDO::FETCH_ASSOC);
                        if (!$row) {
                            $skipped++;
                            continue;
                        }

                        $session = [
                            'authType' => !empty($row['auth_type']) ? (string)$row['auth_type'] : 'password',
                            'did' => (string)($row['did'] ?? $did),
                            'handle' => isset($row['handle']) ? (string)$row['handle'] : null,
                            'pds' => isset($row['pds']) ? (string)$row['pds'] : null,
                            'accessJwt' => (string)($row['access_jwt'] ?? ''),
                            'refreshJwt' => (string)($row['refresh_jwt'] ?? ''),
                            'authIssuer' => isset($row['auth_issuer']) ? (string)$row['auth_issuer'] : null,
                            'dpopPrivatePem' => isset($row['dpop_private_pem']) ? (string)$row['dpop_private_pem'] : null,
                            'dpopPublicJwk' => !empty($row['dpop_public_jwk']) ? (json_decode((string)$row['dpop_public_jwk'], true) ?: null) : null,
                            'authDpopNonce' => isset($row['auth_dpop_nonce']) ? (string)$row['auth_dpop_nonce'] : null,
                            'resourceDpopNonce' => isset($row['resource_dpop_nonce']) ? (string)$row['resource_dpop_nonce'] : null,
                            'tokenExpiresAt' => isset($row['token_expires_at']) ? (string)$row['token_expires_at'] : null,
                        ];

                        try {
                            // Refresh tokens if needed (also persists the refreshed session).
                            $session = $this->maybeRefresh($session, $pdo, $c5UserId);

                            // Ensure requests go to the correct PDS for this account.
                            if (!empty($session['pds'])) {
                                $this->pds = rtrim((string)$session['pds'], '/');
                            }

                            $prof = $this->xrpcSession('GET', 'app.bsky.actor.getProfile', $session, ['actor' => $did]);
                            if (is_array($prof)) {
                                $this->cacheUpsertProfile($pdo, $prof);
                                if (!empty($prof['handle'])) {
                                    $session['handle'] = (string)$prof['handle'];
                                }
                            }

                            // Persist any updated nonces/handle.
                            $this->authSessionUpsert($pdo, $c5UserId, $session);

                            $updated++;
                        } catch (\Throwable $e) {
                            $errors++;
                        }
                    }
                } finally {
                    $this->pds = $prevPds;
                }

                return $this->json([
                    'ok' => true,
                    'updated' => $updated,
                    'skipped' => $skipped,
                    'errors' => $errors,
                    'staleHours' => $staleHours,
                ]);
            }

            if ($method === 'authLogin') {
                $identifier = (string)($params['identifier'] ?? '');
                $password = (string)($params['appPassword'] ?? $params['password'] ?? '');
                $pds = isset($params['pds']) ? (string)$params['pds'] : null;
                if ($identifier === '' || $password === '') {
                    return $this->json(['error' => 'Missing identifier/appPassword'], 400);
                }

                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);

                $sess = $this->createSessionWithPassword($identifier, $password, $pds);
                $this->authSessionUpsert($pdo, $c5UserId, $sess);
                $this->cacheAccountsUpsert(
                    $pdo,
                    $c5UserId,
                    (string)($sess['did'] ?? ''),
                    isset($sess['handle']) ? (string)$sess['handle'] : null,
                    isset($sess['pds']) ? (string)$sess['pds'] : null,
                    null
                );

                // Return profile so UI can immediately render.
                $this->pds = $sess['pds'] ?? $this->pds;
                $me = $this->xrpc('GET', 'app.bsky.actor.getProfile', $sess['accessJwt'], ['actor' => $sess['did']]);
                // Cache it for account manager + identity rendering.
                $this->cacheUpsertProfile($pdo, is_array($me) ? $me : []);

                // Persist account creation date (profile createdAt) into the Concrete user account list.
                try {
                    $createdAt = (is_array($me) && isset($me['createdAt'])) ? trim((string)$me['createdAt']) : '';
                    $createdAt = $createdAt !== '' ? $createdAt : null;
                    $this->cacheAccountsUpsert(
                        $pdo,
                        $c5UserId,
                        (string)($sess['did'] ?? ''),
                        isset($sess['handle']) ? (string)$sess['handle'] : null,
                        isset($sess['pds']) ? (string)$sess['pds'] : null,
                        $createdAt
                    );
                } catch (\Throwable $e) {
                    // ignore
                }
                return $this->json(['ok' => true, 'session' => ['did' => $sess['did'], 'handle' => $sess['handle'] ?? null, 'pds' => $sess['pds'] ?? null], 'profile' => $me]);
            }

            if ($method === 'oauthStart') {
                $issuer = isset($params['issuer']) ? (string)$params['issuer'] : (getenv('BSKY_OAUTH_ISSUER') ?: 'https://bsky.social');
                $issuer = rtrim($issuer, '/');
                $loginHint = isset($params['loginHint']) ? trim((string)$params['loginHint']) : null;
                $scope = isset($params['scope']) ? trim((string)$params['scope']) : 'atproto transition:generic';

                $host = rtrim((string)$this->request->getSchemeAndHttpHost(), '/');
                $base = $this->appBasePath();
                $clientId = $host . $base . '/oauth/client_metadata';
                $redirectUri = $host . $base . '/oauth/callback';

                $pkce = $this->oauthPkce();
                $state = $this->oauthRandomToken(20);
                $dpopKeypair = $this->ecGenerateP256();

                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);

                // Replace any in-progress states for this Concrete user.
                $pdo->prepare('DELETE FROM oauth_states WHERE c5_user_id = :u')->execute([':u' => $c5UserId]);
                $pdo->prepare('INSERT INTO oauth_states(state, c5_user_id, issuer, code_verifier, dpop_private_pem, dpop_public_jwk, login_hint, created_at)
                    VALUES(:s,:u,:iss,:v,:priv,:pub,:hint,:t)')->execute([
                    ':s' => $state,
                    ':u' => $c5UserId,
                    ':iss' => $issuer,
                    ':v' => $pkce['verifier'],
                    ':priv' => $dpopKeypair['private_pem'],
                    ':pub' => json_encode($dpopKeypair['public_jwk'], JSON_UNESCAPED_SLASHES),
                    ':hint' => $loginHint ?: null,
                    ':t' => gmdate('c'),
                ]);

                try {
                    $asMeta = $this->oauthFetchAuthServerMetadata($issuer);
                    $nonce = null;
                    $par = $this->oauthPar($asMeta, $clientId, $redirectUri, $scope, $state, $pkce['challenge'], $loginHint ?: null, $dpopKeypair, $nonce);
                } catch (\Throwable $e) {
                    // Most common misconfiguration: Bluesky can't fetch our client metadata URL (often because the page is protected and redirects to /login).
                    $em = (string)$e->getMessage();
                    if (stripos($em, 'invalid_client_metadata') !== false || stripos($em, 'obtain client metadata') !== false) {
                        Log::error('[BSKY oauthStart] invalid_client_metadata for ' . $clientId . ' :: ' . $em);
                        throw new \RuntimeException(
                            'OAuth setup error: Bluesky could not fetch this client metadata URL: ' . $clientId
                            . '. Make that page publicly viewable (not behind Concrete login) and ensure it returns JSON (HTTP 200) with client metadata.',
                            500
                        );
                    }
                    Log::error('[BSKY oauthStart] ' . $em);
                    throw $e;
                }

                $authz = (string)($asMeta['authorization_endpoint'] ?? '');
                if ($authz === '' || empty($par['request_uri'])) {
                    return $this->json(['error' => 'OAuth server missing authorization_endpoint'], 500);
                }
                $authorizeUrl = $authz . '?client_id=' . rawurlencode($clientId) . '&request_uri=' . rawurlencode((string)$par['request_uri']);

                return $this->json([
                    'ok' => true,
                    'authorizeUrl' => $authorizeUrl,
                    'state' => $state,
                    'issuer' => $issuer,
                    'clientId' => $clientId,
                    'redirectUri' => $redirectUri,
                    'scope' => $scope,
                ]);
            }

            // All other endpoints require an existing Bluesky session.
            $session = $this->ensureSession();

            switch ($method) {
                /* ===================== groups (site-local; facebook groups parity) ===================== */

                case 'groupsList': {
                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $st = $pdo->prepare('SELECT g.group_id, g.slug, g.name, g.description, g.visibility, g.owner_did, g.created_at, g.updated_at,
                        (SELECT COUNT(1) FROM group_members gm WHERE gm.group_id = g.group_id AND gm.state = "member") AS members_count,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state,
                        (SELECT gm.role FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_role
                        FROM groups g
                        ORDER BY g.created_at DESC');
                    $st->execute([':me' => $meDid]);
                    $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    return $this->json(['ok' => true, 'meDid' => $meDid, 'meIsSuper' => $meIsSuper, 'groups' => $rows]);
                }

                case 'groupGet': {
                    $slug = isset($params['slug']) ? trim((string)$params['slug']) : '';
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($slug === '' && $groupId <= 0) return $this->json(['error' => 'Missing slug or groupId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if ($groupId > 0) {
                        $st = $pdo->prepare('SELECT g.group_id, g.slug, g.name, g.description, g.rules_md, g.rules_updated_at, g.post_cooldown_seconds, g.visibility, g.owner_did, g.created_at, g.updated_at,
                            (SELECT COUNT(1) FROM group_members gm WHERE gm.group_id = g.group_id AND gm.state = "member") AS members_count,
                            (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state,
                            (SELECT gm.role FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_role,
                            (SELECT gm.rules_accepted_at FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_rules_accepted_at,
                            (SELECT gm.suspended_until FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_suspended_until,
                            (SELECT gm.banned_at FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_banned_at
                            FROM groups g WHERE g.group_id = :id LIMIT 1');
                        $st->execute([':id' => $groupId, ':me' => $meDid]);
                    } else {
                        $st = $pdo->prepare('SELECT g.group_id, g.slug, g.name, g.description, g.rules_md, g.rules_updated_at, g.post_cooldown_seconds, g.visibility, g.owner_did, g.created_at, g.updated_at,
                            (SELECT COUNT(1) FROM group_members gm WHERE gm.group_id = g.group_id AND gm.state = "member") AS members_count,
                            (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state,
                            (SELECT gm.role FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_role,
                            (SELECT gm.rules_accepted_at FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_rules_accepted_at,
                            (SELECT gm.suspended_until FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_suspended_until,
                            (SELECT gm.banned_at FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_banned_at
                            FROM groups g WHERE g.slug = :slug LIMIT 1');
                        $st->execute([':slug' => $slug, ':me' => $meDid]);
                    }

                    $row = $st->fetch(\PDO::FETCH_ASSOC);
                    if (!$row) return $this->json(['error' => 'Group not found'], 404);
                    return $this->json(['ok' => true, 'group' => $row]);
                }

                case 'groupCreate': {
                    // MVP: group creation is admin-only.
                    $this->requireSuperUser($jwt);

                    $slug = trim((string)($params['slug'] ?? ''));
                    $name = trim((string)($params['name'] ?? ''));
                    $description = isset($params['description']) ? trim((string)$params['description']) : null;
                    $visibility = trim((string)($params['visibility'] ?? 'public'));
                    if ($slug === '' || $name === '') return $this->json(['error' => 'Missing slug or name'], 400);
                    if (!preg_match('/^[a-z0-9][a-z0-9-]{1,63}$/', $slug)) {
                        return $this->json(['error' => 'Invalid slug (use lowercase letters, digits, and dashes)'], 400);
                    }
                    if (!in_array($visibility, ['public', 'closed', 'secret'], true)) $visibility = 'public';

                    $ownerDid = (string)($session['did'] ?? '');
                    if ($ownerDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $st = $pdo->prepare('INSERT INTO groups(slug, name, description, visibility, owner_did, created_at, updated_at)
                            VALUES(:slug,:name,:desc,:vis,:owner,:t,:t)');
                        $st->execute([
                            ':slug' => $slug,
                            ':name' => $name,
                            ':desc' => ($description === '' ? null : $description),
                            ':vis' => $visibility,
                            ':owner' => $ownerDid,
                            ':t' => $now,
                        ]);
                        $gid = (int)$pdo->lastInsertId();

                        // Owner is also a member/admin.
                        $st2 = $pdo->prepare('INSERT INTO group_members(group_id, member_did, state, role, joined_at, created_at, updated_at)
                            VALUES(:g,:did,"member","admin",:t,:t,:t)
                            ON CONFLICT(group_id, member_did) DO UPDATE SET state=excluded.state, role=excluded.role, joined_at=excluded.joined_at, updated_at=excluded.updated_at');
                        $st2->execute([':g' => $gid, ':did' => $ownerDid, ':t' => $now]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $gid,
                            ':a' => $ownerDid,
                            ':act' => 'group.create',
                            ':sub' => $slug,
                            ':det' => json_encode(['name' => $name, 'visibility' => $visibility], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $gid, 'slug' => $slug]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupUpdate': {
                    // MVP: admin-only.
                    $this->requireSuperUser($jwt);

                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $name = isset($params['name']) ? trim((string)$params['name']) : null;
                    $description = array_key_exists('description', (array)$params) ? trim((string)($params['description'] ?? '')) : null;
                    $visibility = isset($params['visibility']) ? trim((string)$params['visibility']) : null;
                    if ($visibility !== null && !in_array($visibility, ['public', 'closed', 'secret'], true)) $visibility = null;

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stHave = $pdo->prepare('SELECT group_id FROM groups WHERE group_id = :g LIMIT 1');
                    $stHave->execute([':g' => $groupId]);
                    if ($stHave->fetchColumn() === false) return $this->json(['error' => 'Group not found'], 404);

                    $sets = [];
                    $bind = [':g' => $groupId, ':t' => gmdate('c')];
                    if ($name !== null && $name !== '') { $sets[] = 'name = :name'; $bind[':name'] = $name; }
                    if ($description !== null) { $sets[] = 'description = :desc'; $bind[':desc'] = ($description === '' ? null : $description); }
                    if ($visibility !== null) { $sets[] = 'visibility = :vis'; $bind[':vis'] = $visibility; }
                    if (!$sets) return $this->json(['ok' => true, 'updated' => 0]);

                    $sql = 'UPDATE groups SET ' . implode(', ', $sets) . ', updated_at = :t WHERE group_id = :g';
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare($sql)->execute($bind);
                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.update',
                            ':sub' => (string)$groupId,
                            ':det' => json_encode(['name' => $name, 'description' => $description, 'visibility' => $visibility], JSON_UNESCAPED_SLASHES),
                            ':t' => $bind[':t'],
                        ]);
                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                    return $this->json(['ok' => true, 'updated' => 1]);
                }

                case 'groupRulesAccept': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT rules_md FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    $rulesMd = (string)($stG->fetchColumn() ?: '');
                    if ($rulesMd === '' || trim($rulesMd) === '') {
                        return $this->json(['error' => 'This group has no rules to accept'], 400);
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $st = $pdo->prepare('UPDATE group_members
                            SET rules_accepted_at = :t, updated_at = :t
                            WHERE group_id = :g AND member_did = :me AND state IN ("member","pending")');
                        $st->execute([':g' => $groupId, ':me' => $meDid, ':t' => $now]);
                        if ($st->rowCount() < 1) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership required'], 403);
                        }

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.rules.accept',
                            ':sub' => $meDid,
                            ':det' => null,
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'acceptedAt' => $now]);
                }

                case 'groupRulesUpdate': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $rulesMd = array_key_exists('rulesMd', (array)$params) ? (string)($params['rulesMd'] ?? '') : null;
                    if ($rulesMd === null) return $this->json(['error' => 'Missing rulesMd'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $stHave = $pdo->prepare('SELECT rules_md FROM groups WHERE group_id = :g LIMIT 1');
                    $stHave->execute([':g' => $groupId]);
                    $curRules = $stHave->fetchColumn();
                    if ($curRules === false) return $this->json(['error' => 'Group not found'], 404);

                    $curRulesStr = (string)($curRules ?? '');
                    if ($curRulesStr === (string)$rulesMd) {
                        return $this->json(['ok' => true, 'updated' => 0]);
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('UPDATE groups SET rules_md = :md, rules_updated_at = :t, updated_at = :t WHERE group_id = :g')
                            ->execute([':md' => ($rulesMd === '' ? null : $rulesMd), ':t' => $now, ':g' => $groupId]);

                        // If rules changed, require members to re-accept (site-local).
                        $pdo->prepare('UPDATE group_members SET rules_accepted_at = NULL, updated_at = :t WHERE group_id = :g')
                            ->execute([':g' => $groupId, ':t' => $now]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.rules.update',
                            ':sub' => (string)$groupId,
                            ':det' => json_encode(['len' => strlen((string)$rulesMd)], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'updated' => 1, 'rulesUpdatedAt' => $now]);
                }

                case 'groupPostingSettingsUpdate': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $cooldown = isset($params['postCooldownSeconds']) ? (int)$params['postCooldownSeconds'] : 0;
                    if ($cooldown < 0) $cooldown = 0;
                    if ($cooldown > 86400) $cooldown = 86400;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $stHave = $pdo->prepare('SELECT post_cooldown_seconds FROM groups WHERE group_id = :g LIMIT 1');
                    $stHave->execute([':g' => $groupId]);
                    $cur = $stHave->fetchColumn();
                    if ($cur === false) return $this->json(['error' => 'Group not found'], 404);
                    $curI = (int)($cur ?? 0);
                    if ($curI === $cooldown) return $this->json(['ok' => true, 'updated' => 0]);

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('UPDATE groups SET post_cooldown_seconds = :c, updated_at = :t WHERE group_id = :g')
                            ->execute([':c' => $cooldown, ':t' => $now, ':g' => $groupId]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.posting.update',
                            ':sub' => (string)$groupId,
                            ':det' => json_encode(['postCooldownSeconds' => $cooldown], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'updated' => 1, 'postCooldownSeconds' => $cooldown]);
                }

                case 'groupJoin': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $inviteToken = isset($params['inviteToken']) ? trim((string)$params['inviteToken']) : '';

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // If user was directly invited, joining should accept that invite.
                    $wasInvited = false;
                    try {
                        $stCur = $pdo->prepare('SELECT state FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stCur->execute([':g' => $groupId, ':did' => $meDid]);
                        $curState = (string)($stCur->fetchColumn() ?: '');
                        if ($curState === 'invited') $wasInvited = true;
                    } catch (\Throwable $e) {
                        $wasInvited = false;
                    }

                    // Banned users cannot re-join.
                    try {
                        $stBan = $pdo->prepare('SELECT state, banned_at FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stBan->execute([':g' => $groupId, ':did' => $meDid]);
                        $banRow = $stBan->fetch(\PDO::FETCH_ASSOC);
                        $banState = (string)($banRow['state'] ?? '');
                        $banAt = (string)($banRow['banned_at'] ?? '');
                        if ($banState === 'blocked' || $banAt !== '') {
                            return $this->json(['error' => 'You are banned from this group', 'code' => 'banned'], 403);
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    $stG = $pdo->prepare('SELECT visibility FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    $vis = (string)($stG->fetchColumn() ?: '');
                    if ($vis === '') return $this->json(['error' => 'Group not found'], 404);
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';

                    // Secret groups should not be joinable without an invite.
                    if ($vis === 'secret') {
                        if ($inviteToken === '') return $this->json(['error' => 'This group is invite-only'], 403);
                        $hash = hash('sha256', $inviteToken);
                        $stInv = $pdo->prepare('SELECT revoked_at, expires_at FROM group_invites WHERE group_id = :g AND token_hash = :h LIMIT 1');
                        $stInv->execute([':g' => $groupId, ':h' => $hash]);
                        $inv = $stInv->fetch(\PDO::FETCH_ASSOC);
                        if (!$inv) return $this->json(['error' => 'Invalid invite token'], 403);
                        if (!empty($inv['revoked_at'])) return $this->json(['error' => 'Invite token revoked'], 403);
                        if (!empty($inv['expires_at'])) {
                            $expTs = strtotime((string)$inv['expires_at']);
                            if ($expTs && $expTs <= time()) return $this->json(['error' => 'Invite token expired'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $state = ($vis === 'closed') ? 'pending' : 'member';
                    if ($inviteToken !== '') {
                        // Invite bypasses pending (MVP).
                        $state = 'member';
                    }
                    if ($wasInvited) {
                        // Direct invitation (site-local) bypasses pending.
                        $state = 'member';
                    }

                    $pdo->beginTransaction();
                    try {
                        $st = $pdo->prepare('INSERT INTO group_members(group_id, member_did, state, role, joined_at, created_at, updated_at)
                            VALUES(:g,:did,:state,"member",:joined,:t,:t)
                            ON CONFLICT(group_id, member_did) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, joined_at=excluded.joined_at');
                        $st->execute([
                            ':g' => $groupId,
                            ':did' => $meDid,
                            ':state' => $state,
                            ':joined' => ($state === 'member' ? $now : null),
                            ':t' => $now,
                        ]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.join',
                            ':sub' => $meDid,
                            ':det' => json_encode(['state' => $state], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        if ($inviteToken !== '') {
                            $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                                VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                                ':g' => $groupId,
                                ':a' => $meDid,
                                ':act' => 'group.invite.accept',
                                ':sub' => $meDid,
                                ':det' => json_encode(['via' => 'invite'], JSON_UNESCAPED_SLASHES),
                                ':t' => $now,
                            ]);
                        }

                        if ($wasInvited) {
                            $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                                VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                                ':g' => $groupId,
                                ':a' => $meDid,
                                ':act' => 'group.invite.accept',
                                ':sub' => $meDid,
                                ':det' => json_encode(['via' => 'direct'], JSON_UNESCAPED_SLASHES),
                                ':t' => $now,
                            ]);
                        }

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                    return $this->json(['ok' => true, 'state' => $state]);
                }

                case 'groupInviteAccept': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    $stHave = $pdo->prepare('SELECT state, banned_at FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                    $stHave->execute([':g' => $groupId, ':did' => $meDid]);
                    $row = $stHave->fetch(\PDO::FETCH_ASSOC);
                    if (!$row) return $this->json(['error' => 'Invite not found'], 404);
                    $state = (string)($row['state'] ?? '');
                    $bannedAt = (string)($row['banned_at'] ?? '');
                    if ($state === 'blocked' || $bannedAt !== '') return $this->json(['error' => 'You are banned from this group'], 403);
                    if ($state !== 'invited') return $this->json(['error' => 'No pending invite to accept'], 409);

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('UPDATE group_members SET state = "member", joined_at = COALESCE(joined_at, :t), updated_at = :t WHERE group_id = :g AND member_did = :did')
                            ->execute([':t' => $now, ':g' => $groupId, ':did' => $meDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.invite.accept',
                            ':sub' => $meDid,
                            ':det' => json_encode(['via' => 'direct'], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);
                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'state' => 'member']);
                }

                case 'groupLeave': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('DELETE FROM group_members WHERE group_id = :g AND member_did = :did')
                            ->execute([':g' => $groupId, ':did' => $meDid]);
                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.leave',
                            ':sub' => $meDid,
                            ':det' => null,
                            ':t' => $now,
                        ]);
                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                    return $this->json(['ok' => true]);
                }

                case 'groupAuditList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $limit = isset($params['limit']) ? (int)$params['limit'] : 50;
                    if ($limit < 1) $limit = 1;
                    if ($limit > 200) $limit = 200;

                    $before = isset($params['before']) ? trim((string)$params['before']) : '';
                    if ($before === '') $before = null;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // Access control: public groups are visible; closed/secret require membership (or superuser).
                    $stG = $pdo->prepare('SELECT g.visibility,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    if (!$meIsSuper && $vis !== 'public' && $myState !== 'member') {
                        return $this->json(['error' => 'Membership required'], 403);
                    }

                    if ($before !== null) {
                        $st = $pdo->prepare('SELECT id, actor_did, action, subject, detail, created_at
                            FROM group_audit
                            WHERE group_id = :g AND created_at < :before
                            ORDER BY created_at DESC, id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':before', $before, \PDO::PARAM_STR);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    } else {
                        $st = $pdo->prepare('SELECT id, actor_did, action, subject, detail, created_at
                            FROM group_audit
                            WHERE group_id = :g
                            ORDER BY created_at DESC, id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    }

                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    $nextBefore = null;
                    if ($items) {
                        $last = $items[count($items) - 1];
                        $nextBefore = !empty($last['created_at']) ? (string)$last['created_at'] : null;
                    }
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'items' => $items, 'nextBefore' => $nextBefore]);
                }

                case 'groupAuditExport': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $format = strtolower(trim((string)($params['format'] ?? 'json')));
                    if (!in_array($format, ['json', 'csv'], true)) $format = 'json';

                    $limit = isset($params['limit']) ? (int)$params['limit'] : 1000;
                    if ($limit < 1) $limit = 1;
                    if ($limit > 5000) $limit = 5000;

                    $before = isset($params['before']) ? trim((string)$params['before']) : '';
                    if ($before === '') $before = null;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // Access control: public groups are visible; closed/secret require membership (or superuser).
                    $stG = $pdo->prepare('SELECT g.slug, g.visibility,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $slug = (string)($g['slug'] ?? '');
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    if (!$meIsSuper && $vis !== 'public' && $myState !== 'member') {
                        return $this->json(['error' => 'Membership required'], 403);
                    }

                    if ($before !== null) {
                        $st = $pdo->prepare('SELECT id, group_id, actor_did, action, subject, detail, created_at
                            FROM group_audit
                            WHERE group_id = :g AND created_at < :before
                            ORDER BY created_at DESC, id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':before', $before, \PDO::PARAM_STR);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    } else {
                        $st = $pdo->prepare('SELECT id, group_id, actor_did, action, subject, detail, created_at
                            FROM group_audit
                            WHERE group_id = :g
                            ORDER BY created_at DESC, id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    }

                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    $safeSlug = preg_replace('/[^a-z0-9_\-]+/i', '_', $slug ?: ('group_' . $groupId));
                    $ts = gmdate('Ymd_His');
                    $filename = 'group_audit_' . $safeSlug . '_' . $ts . '.' . $format;

                    if ($format === 'csv') {
                        $fh = fopen('php://temp', 'w+');
                        if ($fh === false) return $this->json(['error' => 'Could not create export buffer'], 500);

                        fputcsv($fh, ['id', 'group_id', 'actor_did', 'action', 'subject', 'detail', 'created_at']);
                        foreach ($items as $it) {
                            fputcsv($fh, [
                                (string)($it['id'] ?? ''),
                                (string)($it['group_id'] ?? ''),
                                (string)($it['actor_did'] ?? ''),
                                (string)($it['action'] ?? ''),
                                (string)($it['subject'] ?? ''),
                                (string)($it['detail'] ?? ''),
                                (string)($it['created_at'] ?? ''),
                            ]);
                        }
                        rewind($fh);
                        $csv = stream_get_contents($fh);
                        fclose($fh);
                        if ($csv === false) $csv = '';
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'format' => 'csv', 'filename' => $filename, 'csv' => $csv, 'count' => count($items)]);
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'format' => 'json', 'filename' => $filename, 'items' => $items, 'count' => count($items)]);
                }

                case 'groupPinsList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT g.visibility,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    if (!$meIsSuper && $vis !== 'public' && $myState !== 'member') {
                        return $this->json(['error' => 'Membership required'], 403);
                    }

                    $st = $pdo->prepare('SELECT post_uri, pinned_by_did, pinned_at, sort_order, is_announcement, note
                        FROM group_pins
                        WHERE group_id = :g
                        ORDER BY COALESCE(sort_order, 0) ASC, pinned_at DESC');
                    $st->execute([':g' => $groupId]);
                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'items' => $items]);
                }

                case 'groupPinAdd': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $postUri = trim((string)($params['postUri'] ?? ''));
                    $isAnnouncement = !empty($params['isAnnouncement']);
                    $note = trim((string)($params['note'] ?? ''));
                    if ($groupId <= 0 || $postUri === '') return $this->json(['error' => 'Missing groupId or postUri'], 400);
                    if (strlen($postUri) > 1024) return $this->json(['error' => 'postUri too long'], 400);
                    if (strlen($note) > 2000) $note = substr($note, 0, 2000);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    $myRole = '';
                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $myRole = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($myRole, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Moderator required'], 403);
                        }
                        if ($isAnnouncement && $myRole !== 'admin') {
                            return $this->json(['error' => 'Admin required for announcements'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stCount = $pdo->prepare('SELECT COUNT(1) FROM group_pins WHERE group_id = :g');
                        $stCount->execute([':g' => $groupId]);
                        $cnt = (int)($stCount->fetchColumn() ?: 0);

                        $stMax = $pdo->prepare('SELECT COALESCE(MAX(sort_order), -1) FROM group_pins WHERE group_id = :g');
                        $stMax->execute([':g' => $groupId]);
                        $nextOrder = (int)($stMax->fetchColumn() ?: -1) + 1;

                        $stExists = $pdo->prepare('SELECT 1 FROM group_pins WHERE group_id = :g AND post_uri = :u LIMIT 1');
                        $stExists->execute([':g' => $groupId, ':u' => $postUri]);
                        $exists = (bool)$stExists->fetchColumn();
                        if (!$exists && $cnt >= 5) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Pin limit reached (5)'], 409);
                        }

                        $pdo->prepare('INSERT INTO group_pins(group_id, post_uri, pinned_by_did, pinned_at, sort_order, is_announcement, note)
                            VALUES(:g,:u,:by,:t,:ord,:ann,:note)
                            ON CONFLICT(group_id, post_uri) DO UPDATE SET pinned_by_did=excluded.pinned_by_did, pinned_at=excluded.pinned_at, sort_order=excluded.sort_order, is_announcement=excluded.is_announcement, note=excluded.note')
                            ->execute([
                                ':g' => $groupId,
                                ':u' => $postUri,
                                ':by' => $actorDid,
                                ':t' => $now,
                                ':ord' => $nextOrder,
                                ':ann' => $isAnnouncement ? 1 : 0,
                                ':note' => ($note === '' ? null : $note),
                            ]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.pin.add',
                            ':sub' => $postUri,
                            ':det' => json_encode(['isAnnouncement' => $isAnnouncement ? true : false], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true]);
                }

                case 'groupPinUpdate': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $postUri = trim((string)($params['postUri'] ?? ''));
                    $note = array_key_exists('note', $params) ? (string)($params['note'] ?? '') : null;
                    $setAnnouncement = array_key_exists('isAnnouncement', $params);
                    $isAnnouncement = !empty($params['isAnnouncement']);
                    if ($groupId <= 0 || $postUri === '') return $this->json(['error' => 'Missing groupId or postUri'], 400);
                    if ($note !== null && strlen($note) > 2000) $note = substr($note, 0, 2000);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    $myRole = '';
                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $myRole = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($myRole, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Moderator required'], 403);
                        }
                        if ($setAnnouncement && $myRole !== 'admin') {
                            return $this->json(['error' => 'Admin required for announcements'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT is_announcement, note FROM group_pins WHERE group_id = :g AND post_uri = :u LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':u' => $postUri]);
                        $row = $stHave->fetch(\PDO::FETCH_ASSOC);
                        if (!$row) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Pin not found'], 404);
                        }

                        $parts = [];
                        $bind = [':g' => $groupId, ':u' => $postUri];
                        if ($note !== null) {
                            $parts[] = 'note = :note';
                            $bind[':note'] = (trim($note) === '') ? null : $note;
                        }
                        if ($setAnnouncement) {
                            $parts[] = 'is_announcement = :ann';
                            $bind[':ann'] = $isAnnouncement ? 1 : 0;
                        }
                        if (!$parts) {
                            $pdo->rollBack();
                            return $this->json(['ok' => true, 'updated' => 0]);
                        }

                        $sql = 'UPDATE group_pins SET ' . implode(', ', $parts) . ' WHERE group_id = :g AND post_uri = :u';
                        $pdo->prepare($sql)->execute($bind);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.pin.update',
                            ':sub' => $postUri,
                            ':det' => json_encode(['note' => $note, 'setAnnouncement' => $setAnnouncement ? true : false], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'updated' => 1]);
                }

                case 'groupPinsReorder': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $order = $params['order'] ?? null;
                    if ($groupId <= 0 || !is_array($order)) return $this->json(['error' => 'Missing groupId or order[]'], 400);
                    $order = array_values(array_unique(array_filter(array_map('strval', $order))));
                    if (!$order) return $this->json(['error' => 'Missing order[]'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $myRole = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($myRole, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Moderator required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        // Existing pins in current display order.
                        $stPins = $pdo->prepare('SELECT post_uri FROM group_pins WHERE group_id = :g ORDER BY COALESCE(sort_order, 0) ASC, pinned_at DESC');
                        $stPins->execute([':g' => $groupId]);
                        $existingOrdered = $stPins->fetchAll(\PDO::FETCH_COLUMN, 0) ?: [];
                        $existingSet = array_fill_keys(array_map('strval', $existingOrdered), true);

                        // Only keep URIs that currently exist as pins.
                        $filtered = [];
                        foreach ($order as $u) {
                            if (isset($existingSet[$u])) $filtered[] = $u;
                        }

                        // Append remaining pins, preserving current order.
                        $mentioned = array_fill_keys($filtered, true);
                        $rest = [];
                        foreach ($existingOrdered as $u) {
                            $u = (string)$u;
                            if (!isset($mentioned[$u])) $rest[] = $u;
                        }

                        $final = array_values(array_merge($filtered, $rest));
                        $i = 0;
                        $stUp = $pdo->prepare('UPDATE group_pins SET sort_order = :o WHERE group_id = :g AND post_uri = :u');
                        foreach ($final as $u) {
                            $stUp->execute([':o' => $i, ':g' => $groupId, ':u' => $u]);
                            $i++;
                        }

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.pin.reorder',
                            ':sub' => null,
                            ':det' => json_encode(['count' => count($final)], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);
                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true]);
                }

                case 'groupPinRemove': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $postUri = trim((string)($params['postUri'] ?? ''));
                    if ($groupId <= 0 || $postUri === '') return $this->json(['error' => 'Missing groupId or postUri'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $myRole = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($myRole, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Moderator required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('DELETE FROM group_pins WHERE group_id = :g AND post_uri = :u')
                            ->execute([':g' => $groupId, ':u' => $postUri]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.pin.remove',
                            ':sub' => $postUri,
                            ':det' => null,
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true]);
                }

                case 'groupPostSubmit': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $text = trim((string)($params['text'] ?? ''));
                    if ($text === '') return $this->json(['error' => 'Missing text'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT g.slug, g.visibility, g.rules_md, g.post_cooldown_seconds,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state,
                        (SELECT gm.role FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_role,
                        (SELECT gm.rules_accepted_at FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_rules_accepted_at,
                        (SELECT gm.suspended_until FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_suspended_until,
                        (SELECT gm.banned_at FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_banned_at
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $slug = (string)($g['slug'] ?? '');
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    $rulesMd = (string)($g['rules_md'] ?? '');
                    $myRulesAcceptedAt = (string)($g['my_rules_accepted_at'] ?? '');
                    $myRole = (string)($g['my_role'] ?? '');
                    $cooldownSeconds = (int)($g['post_cooldown_seconds'] ?? 0);
                    $suspendedUntil = (string)($g['my_suspended_until'] ?? '');
                    $bannedAt = (string)($g['my_banned_at'] ?? '');

                    if (!$meIsSuper) {
                        if ($bannedAt !== '') {
                            return $this->json(['error' => 'You are banned from this group', 'code' => 'banned'], 403);
                        }
                        if ($suspendedUntil !== '') {
                            $suTs = strtotime($suspendedUntil);
                            if ($suTs && $suTs > time()) {
                                $retry = $suTs - time();
                                if ($retry < 1) $retry = 1;
                                return $this->json(['error' => 'You are suspended from posting in this group', 'code' => 'suspended', 'retryAfterSeconds' => $retry], 403);
                            }
                        }

                        if ($myState !== 'member') {
                            return $this->json(['error' => 'Membership required'], 403);
                        }

                        $hasRules = trim($rulesMd) !== '';
                        if ($hasRules && $myRulesAcceptedAt === '') {
                            return $this->json(['error' => 'You must accept the group rules before posting', 'code' => 'rules_required'], 403);
                        }

                        // Slow-mode: enforce minimum seconds between submissions for non-mod members.
                        if ($cooldownSeconds > 0 && !in_array($myRole, ['admin', 'moderator'], true)) {
                            $stLast = $pdo->prepare('SELECT created_at FROM group_posts WHERE group_id = :g AND author_did = :me ORDER BY post_id DESC LIMIT 1');
                            $stLast->execute([':g' => $groupId, ':me' => $meDid]);
                            $lastAt = (string)($stLast->fetchColumn() ?: '');
                            $lastTs = $lastAt !== '' ? strtotime($lastAt) : 0;
                            if ($lastTs > 0) {
                                $nowTs = time();
                                $delta = $nowTs - $lastTs;
                                if ($delta < $cooldownSeconds) {
                                    $retry = $cooldownSeconds - $delta;
                                    if ($retry < 1) $retry = 1;
                                    return $this->json(['error' => 'Slow mode: please wait before posting again', 'code' => 'slow_mode', 'retryAfterSeconds' => $retry], 429);
                                }
                            }
                        }
                    }

                    // Stable group tag (MVP): #csky_<slug> with normalization.
                    $safe = strtolower($slug);
                    $safe = preg_replace('/[^a-z0-9]+/', '_', $safe);
                    $safe = trim((string)$safe, '_');
                    $tag = $safe ? ('#csky_' . $safe) : '';
                    if ($tag !== '') {
                        $re = '/\\b' . preg_quote($tag, '/') . '\\b/i';
                        if (!preg_match($re, $text)) {
                            $text = rtrim($text) . "\n\n" . $tag;
                        }
                    }

                    $langs = (!empty($params['langs']) && is_array($params['langs'])) ? array_values($params['langs']) : null;
                    $facets = (!empty($params['facets']) && is_array($params['facets'])) ? $params['facets'] : null;
                    $embed = (!empty($params['embed']) && is_array($params['embed'])) ? $params['embed'] : null;

                    $now = gmdate('c');
                    $requiresApproval = ($vis === 'closed' || $vis === 'secret');

                    // Phrase filters can force require-approval or deny.
                    try {
                        $stF = $pdo->prepare('SELECT phrase, action FROM group_phrase_filters WHERE group_id = :g');
                        $stF->execute([':g' => $groupId]);
                        $filters = $stF->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                        if ($filters) {
                            $lower = mb_strtolower($text, 'UTF-8');
                            foreach ($filters as $f) {
                                $phrase = trim((string)($f['phrase'] ?? ''));
                                if ($phrase === '') continue;
                                $action = (string)($f['action'] ?? 'require_approval');
                                $pLower = mb_strtolower($phrase, 'UTF-8');
                                if ($pLower !== '' && mb_strpos($lower, $pLower, 0, 'UTF-8') !== false) {
                                    if ($action === 'deny') {
                                        return $this->json(['error' => 'Post blocked by group filter', 'blockedPhrase' => $phrase], 403);
                                    }
                                    $requiresApproval = true;
                                }
                            }
                        }
                    } catch (\Throwable $e) {
                        // ignore filter failures; do not block posting
                    }

                    $pdo->beginTransaction();
                    try {
                        if ($requiresApproval) {
                            $st = $pdo->prepare('INSERT INTO group_posts(group_id, author_did, state, text, langs, facets, embed, created_at)
                                VALUES(:g,:a,"pending",:txt,:langs,:facets,:embed,:t)');
                            $st->execute([
                                ':g' => $groupId,
                                ':a' => $meDid,
                                ':txt' => $text,
                                ':langs' => ($langs ? json_encode($langs, JSON_UNESCAPED_SLASHES) : null),
                                ':facets' => ($facets ? json_encode($facets, JSON_UNESCAPED_SLASHES) : null),
                                ':embed' => ($embed ? json_encode($embed, JSON_UNESCAPED_SLASHES) : null),
                                ':t' => $now,
                            ]);
                            $pid = (int)$pdo->lastInsertId();

                            $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                                VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                                ':g' => $groupId,
                                ':a' => $meDid,
                                ':act' => 'group.post.submit',
                                ':sub' => (string)$pid,
                                ':det' => json_encode(['state' => 'pending'], JSON_UNESCAPED_SLASHES),
                                ':t' => $now,
                            ]);

                            $pdo->commit();
                            return $this->json(['ok' => true, 'groupId' => $groupId, 'postId' => $pid, 'state' => 'pending', 'tag' => $tag]);
                        }

                        // Public groups: auto-approve and create the Bluesky post now.
                        $record = [
                            '$type' => 'app.bsky.feed.post',
                            'text' => $text,
                            'createdAt' => $now,
                        ];
                        if ($langs) $record['langs'] = $langs;
                        if ($facets) $record['facets'] = $facets;
                        if ($embed) $record['embed'] = $embed;
                        $created = $this->createRecord($session, 'app.bsky.feed.post', $record);

                        $uri = (string)($created['uri'] ?? '');
                        $cid = (string)($created['cid'] ?? '');

                        $st = $pdo->prepare('INSERT INTO group_posts(group_id, author_did, state, text, langs, facets, embed, created_post_uri, created_post_cid, created_at, decided_at, decided_by_did)
                            VALUES(:g,:a,"approved",:txt,:langs,:facets,:embed,:uri,:cid,:t,:t,:dec)');
                        $st->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':txt' => $text,
                            ':langs' => ($langs ? json_encode($langs, JSON_UNESCAPED_SLASHES) : null),
                            ':facets' => ($facets ? json_encode($facets, JSON_UNESCAPED_SLASHES) : null),
                            ':embed' => ($embed ? json_encode($embed, JSON_UNESCAPED_SLASHES) : null),
                            ':uri' => ($uri !== '' ? $uri : null),
                            ':cid' => ($cid !== '' ? $cid : null),
                            ':t' => $now,
                            ':dec' => $meDid,
                        ]);
                        $pid = (int)$pdo->lastInsertId();

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.post.create',
                            ':sub' => (string)$pid,
                            ':det' => json_encode(['state' => 'approved', 'uri' => $uri], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'postId' => $pid, 'state' => 'approved', 'uri' => $uri, 'cid' => $cid, 'tag' => $tag]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupPostsList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $limit = isset($params['limit']) ? (int)$params['limit'] : 25;
                    if ($limit < 1) $limit = 1;
                    if ($limit > 100) $limit = 100;

                    $cursor = isset($params['cursor']) ? (int)$params['cursor'] : 0;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT g.visibility,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    if (!$meIsSuper && $vis !== 'public' && $myState !== 'member') {
                        return $this->json(['error' => 'Membership required'], 403);
                    }

                    if ($cursor > 0) {
                        $st = $pdo->prepare('SELECT post_id, author_did, created_post_uri AS uri, created_post_cid AS cid, created_at
                            FROM group_posts
                            WHERE group_id = :g AND state = "approved" AND created_post_uri IS NOT NULL AND post_id < :c
                            ORDER BY post_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':c', $cursor, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    } else {
                        $st = $pdo->prepare('SELECT post_id, author_did, created_post_uri AS uri, created_post_cid AS cid, created_at
                            FROM group_posts
                            WHERE group_id = :g AND state = "approved" AND created_post_uri IS NOT NULL
                            ORDER BY post_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    }

                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    $next = null;
                    if ($items) {
                        $last = $items[count($items) - 1];
                        $next = !empty($last['post_id']) ? (int)$last['post_id'] : null;
                    }
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'items' => $items, 'cursor' => $next]);
                }

                case 'groupPostsPendingList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $limit = isset($params['limit']) ? (int)$params['limit'] : 50;
                    if ($limit < 1) $limit = 1;
                    if ($limit > 200) $limit = 200;

                    $cursor = isset($params['cursor']) ? (int)$params['cursor'] : 0;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    if ($cursor > 0) {
                        $st = $pdo->prepare('SELECT post_id, author_did, text, created_at
                            FROM group_posts
                            WHERE group_id = :g AND state = "pending" AND post_id < :c
                            ORDER BY post_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':c', $cursor, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    } else {
                        $st = $pdo->prepare('SELECT post_id, author_did, text, created_at
                            FROM group_posts
                            WHERE group_id = :g AND state = "pending"
                            ORDER BY post_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    }

                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    $next = null;
                    if ($items) {
                        $last = $items[count($items) - 1];
                        $next = !empty($last['post_id']) ? (int)$last['post_id'] : null;
                    }
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'items' => $items, 'cursor' => $next]);
                }

                case 'groupPostsMineList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $limit = isset($params['limit']) ? (int)$params['limit'] : 25;
                    if ($limit < 1) $limit = 1;
                    if ($limit > 100) $limit = 100;

                    $cursor = isset($params['cursor']) ? (int)$params['cursor'] : 0;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // Must still be a member to view secret/closed group submissions.
                    $stG = $pdo->prepare('SELECT g.visibility,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    if (!$meIsSuper && $vis !== 'public' && $myState !== 'member') {
                        return $this->json(['error' => 'Membership required'], 403);
                    }

                    if ($cursor > 0) {
                        $st = $pdo->prepare('SELECT post_id, state, text, created_at, decided_at, decided_by_did, decision_note, created_post_uri AS uri
                            FROM group_posts
                            WHERE group_id = :g AND author_did = :me AND post_id < :c
                            ORDER BY post_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':me', $meDid, \PDO::PARAM_STR);
                        $st->bindValue(':c', $cursor, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    } else {
                        $st = $pdo->prepare('SELECT post_id, state, text, created_at, decided_at, decided_by_did, decision_note, created_post_uri AS uri
                            FROM group_posts
                            WHERE group_id = :g AND author_did = :me
                            ORDER BY post_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':me', $meDid, \PDO::PARAM_STR);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    }

                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    $next = null;
                    if ($items) {
                        $last = $items[count($items) - 1];
                        $next = !empty($last['post_id']) ? (int)$last['post_id'] : null;
                    }
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'items' => $items, 'cursor' => $next]);
                }

                case 'groupHiddenPostsList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $limit = isset($params['limit']) ? (int)$params['limit'] : 200;
                    if ($limit < 1) $limit = 1;
                    if ($limit > 1000) $limit = 1000;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // Public groups: allow anyone with a valid session. Closed/secret: members only.
                    $stG = $pdo->prepare('SELECT g.visibility,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    if (!$meIsSuper && $vis !== 'public' && $myState !== 'member') {
                        return $this->json(['error' => 'Membership required'], 403);
                    }

                    $st = $pdo->prepare('SELECT post_uri, hidden_by_did, hidden_at, note
                        FROM group_post_hidden
                        WHERE group_id = :g
                        ORDER BY hidden_at DESC
                        LIMIT :lim');
                    $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                    $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                    $st->execute();
                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'items' => $items]);
                }

                case 'groupPostHide': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $uri = trim((string)($params['uri'] ?? ''));
                    $note = isset($params['note']) ? trim((string)$params['note']) : null;
                    if ($groupId <= 0 || $uri === '') return $this->json(['error' => 'Missing groupId/uri'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('INSERT OR REPLACE INTO group_post_hidden(group_id, post_uri, hidden_by_did, hidden_at, note)
                            VALUES(:g,:u,:d,:t,:n)')->execute([
                            ':g' => $groupId,
                            ':u' => $uri,
                            ':d' => $meDid,
                            ':t' => $now,
                            ':n' => ($note === '' ? null : $note),
                        ]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.post.hide',
                            ':sub' => $uri,
                            ':det' => json_encode(['note' => ($note === '' ? null : $note)], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'uri' => $uri]);
                }

                case 'groupPostUnhide': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $uri = trim((string)($params['uri'] ?? ''));
                    if ($groupId <= 0 || $uri === '') return $this->json(['error' => 'Missing groupId/uri'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('DELETE FROM group_post_hidden WHERE group_id = :g AND post_uri = :u')
                            ->execute([':g' => $groupId, ':u' => $uri]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.post.unhide',
                            ':sub' => $uri,
                            ':det' => json_encode(new \stdClass(), JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'uri' => $uri]);
                }

                case 'groupPhraseFiltersList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // Allow listing for members (publicly visible filters are OK for MVP).
                    $st = $pdo->prepare('SELECT phrase, action, created_by_did, created_at FROM group_phrase_filters WHERE group_id = :g ORDER BY phrase ASC');
                    $st->execute([':g' => $groupId]);
                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'items' => $items]);
                }

                case 'groupPhraseFilterAdd': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $phrase = trim((string)($params['phrase'] ?? ''));
                    $action = trim((string)($params['action'] ?? 'require_approval'));
                    if ($groupId <= 0 || $phrase === '') return $this->json(['error' => 'Missing groupId/phrase'], 400);
                    if (!in_array($action, ['require_approval', 'deny'], true)) $action = 'require_approval';

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('INSERT OR REPLACE INTO group_phrase_filters(group_id, phrase, action, created_by_did, created_at)
                            VALUES(:g,:p,:a,:d,:t)')->execute([
                            ':g' => $groupId,
                            ':p' => $phrase,
                            ':a' => $action,
                            ':d' => $meDid,
                            ':t' => $now,
                        ]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.filter.add',
                            ':sub' => $phrase,
                            ':det' => json_encode(['action' => $action], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);
                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'phrase' => $phrase, 'action' => $action]);
                }

                case 'groupPhraseFilterRemove': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $phrase = trim((string)($params['phrase'] ?? ''));
                    if ($groupId <= 0 || $phrase === '') return $this->json(['error' => 'Missing groupId/phrase'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('DELETE FROM group_phrase_filters WHERE group_id = :g AND phrase = :p')
                            ->execute([':g' => $groupId, ':p' => $phrase]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.filter.remove',
                            ':sub' => $phrase,
                            ':det' => json_encode(new \stdClass(), JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);
                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'phrase' => $phrase]);
                }

                case 'groupReportCreate': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $uri = trim((string)($params['uri'] ?? ''));
                    $reason = isset($params['reason']) ? trim((string)$params['reason']) : null;
                    if ($groupId <= 0 || $uri === '') return $this->json(['error' => 'Missing groupId/uri'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // For closed/secret groups: membership required to file reports.
                    $stG = $pdo->prepare('SELECT g.visibility,
                        (SELECT gm.state FROM group_members gm WHERE gm.group_id = g.group_id AND gm.member_did = :me LIMIT 1) AS my_state
                        FROM groups g WHERE g.group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId, ':me' => $meDid]);
                    $g = $stG->fetch(\PDO::FETCH_ASSOC);
                    if (!$g) return $this->json(['error' => 'Group not found'], 404);
                    $vis = (string)($g['visibility'] ?? 'public');
                    if (!in_array($vis, ['public', 'closed', 'secret'], true)) $vis = 'public';
                    $myState = (string)($g['my_state'] ?? '');
                    if (!$meIsSuper && $vis !== 'public' && $myState !== 'member') {
                        return $this->json(['error' => 'Membership required'], 403);
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('INSERT INTO group_reports(group_id, post_uri, reporter_did, reason, state, created_at)
                            VALUES(:g,:u,:d,:r,"open",:t)')->execute([
                            ':g' => $groupId,
                            ':u' => $uri,
                            ':d' => $meDid,
                            ':r' => ($reason === '' ? null : $reason),
                            ':t' => $now,
                        ]);
                        $rid = (int)$pdo->lastInsertId();

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.report.create',
                            ':sub' => (string)$rid,
                            ':det' => json_encode(['uri' => $uri], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'reportId' => $rid]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupReportsList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $state = trim((string)($params['state'] ?? 'open'));
                    if (!in_array($state, ['open', 'resolved'], true)) $state = 'open';

                    $limit = isset($params['limit']) ? (int)$params['limit'] : 50;
                    if ($limit < 1) $limit = 1;
                    if ($limit > 200) $limit = 200;

                    $cursor = isset($params['cursor']) ? (int)$params['cursor'] : 0;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $mState = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($mState !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    if ($cursor > 0) {
                        $st = $pdo->prepare('SELECT report_id, post_uri, reporter_did, reason, state, created_at, resolved_at, resolved_by_did, resolution_note
                            FROM group_reports
                            WHERE group_id = :g AND state = :s AND report_id < :c
                            ORDER BY report_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':s', $state, \PDO::PARAM_STR);
                        $st->bindValue(':c', $cursor, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    } else {
                        $st = $pdo->prepare('SELECT report_id, post_uri, reporter_did, reason, state, created_at, resolved_at, resolved_by_did, resolution_note
                            FROM group_reports
                            WHERE group_id = :g AND state = :s
                            ORDER BY report_id DESC
                            LIMIT :lim');
                        $st->bindValue(':g', $groupId, \PDO::PARAM_INT);
                        $st->bindValue(':s', $state, \PDO::PARAM_STR);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->execute();
                    }

                    $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    $next = null;
                    if ($items) {
                        $last = $items[count($items) - 1];
                        $next = !empty($last['report_id']) ? (int)$last['report_id'] : null;
                    }
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'state' => $state, 'items' => $items, 'cursor' => $next]);
                }

                case 'groupReportResolve': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $reportId = isset($params['reportId']) ? (int)$params['reportId'] : 0;
                    $note = isset($params['note']) ? trim((string)$params['note']) : null;
                    $hide = !empty($params['hide']);
                    if ($groupId <= 0 || $reportId <= 0) return $this->json(['error' => 'Missing groupId/reportId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $mState = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($mState !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $stR = $pdo->prepare('SELECT post_uri, state FROM group_reports WHERE group_id = :g AND report_id = :r LIMIT 1');
                    $stR->execute([':g' => $groupId, ':r' => $reportId]);
                    $r = $stR->fetch(\PDO::FETCH_ASSOC);
                    if (!$r) return $this->json(['error' => 'Report not found'], 404);
                    if ((string)($r['state'] ?? '') !== 'open') return $this->json(['error' => 'Report not open'], 409);
                    $postUri = (string)($r['post_uri'] ?? '');

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('UPDATE group_reports SET state="resolved", resolved_at=:t, resolved_by_did=:d, resolution_note=:n WHERE group_id=:g AND report_id=:r AND state="open"')
                            ->execute([':t' => $now, ':d' => $meDid, ':n' => ($note === '' ? null : $note), ':g' => $groupId, ':r' => $reportId]);

                        if ($hide && $postUri !== '') {
                            $pdo->prepare('INSERT OR REPLACE INTO group_post_hidden(group_id, post_uri, hidden_by_did, hidden_at, note)
                                VALUES(:g,:u,:d,:t,:n)')->execute([
                                ':g' => $groupId,
                                ':u' => $postUri,
                                ':d' => $meDid,
                                ':t' => $now,
                                ':n' => 'hidden via report resolve',
                            ]);
                        }

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.report.resolve',
                            ':sub' => (string)$reportId,
                            ':det' => json_encode(['hide' => $hide, 'uri' => $postUri], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'reportId' => $reportId, 'state' => 'resolved', 'hide' => $hide]);
                }

                case 'groupPostApprove': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $postId = isset($params['postId']) ? (int)$params['postId'] : 0;
                    if ($groupId <= 0 || $postId <= 0) return $this->json(['error' => 'Missing groupId/postId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $stHave = $pdo->prepare('SELECT group_id FROM groups WHERE group_id = :g LIMIT 1');
                    $stHave->execute([':g' => $groupId]);
                    if (!$stHave->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    $stP = $pdo->prepare('SELECT post_id, author_did, state, text, langs, facets, embed FROM group_posts WHERE group_id = :g AND post_id = :p LIMIT 1');
                    $stP->execute([':g' => $groupId, ':p' => $postId]);
                    $row = $stP->fetch(\PDO::FETCH_ASSOC);
                    if (!$row) return $this->json(['error' => 'Post not found'], 404);
                    if ((string)($row['state'] ?? '') !== 'pending') {
                        return $this->json(['error' => 'Post is not pending'], 409);
                    }

                    $text = (string)($row['text'] ?? '');
                    $langs = null;
                    $facets = null;
                    $embed = null;
                    try { $langs = !empty($row['langs']) ? json_decode((string)$row['langs'], true) : null; } catch (\Throwable $e) { $langs = null; }
                    try { $facets = !empty($row['facets']) ? json_decode((string)$row['facets'], true) : null; } catch (\Throwable $e) { $facets = null; }
                    try { $embed = !empty($row['embed']) ? json_decode((string)$row['embed'], true) : null; } catch (\Throwable $e) { $embed = null; }
                    if (!is_array($langs)) $langs = null;
                    if (!is_array($facets)) $facets = null;
                    if (!is_array($embed)) $embed = null;

                    $now = gmdate('c');
                    $record = [
                        '$type' => 'app.bsky.feed.post',
                        'text' => $text,
                        'createdAt' => $now,
                    ];
                    if ($langs) $record['langs'] = array_values($langs);
                    if ($facets) $record['facets'] = $facets;
                    if ($embed) $record['embed'] = $embed;

                    $created = $this->createRecord($session, 'app.bsky.feed.post', $record);
                    $uri = (string)($created['uri'] ?? '');
                    $cid = (string)($created['cid'] ?? '');

                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('UPDATE group_posts SET state="approved", created_post_uri=:uri, created_post_cid=:cid, decided_at=:t, decided_by_did=:d WHERE group_id=:g AND post_id=:p')
                            ->execute([':uri' => ($uri !== '' ? $uri : null), ':cid' => ($cid !== '' ? $cid : null), ':t' => $now, ':d' => $meDid, ':g' => $groupId, ':p' => $postId]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.post.approve',
                            ':sub' => (string)$postId,
                            ':det' => json_encode(['uri' => $uri], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'postId' => $postId, 'state' => 'approved', 'uri' => $uri, 'cid' => $cid]);
                }

                case 'groupPostDeny': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $postId = isset($params['postId']) ? (int)$params['postId'] : 0;
                    if ($groupId <= 0 || $postId <= 0) return $this->json(['error' => 'Missing groupId/postId'], 400);

                    $note = isset($params['note']) ? trim((string)$params['note']) : null;

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $st = $pdo->prepare('UPDATE group_posts SET state="denied", decided_at=:t, decided_by_did=:d, decision_note=:n WHERE group_id=:g AND post_id=:p AND state="pending"');
                        $st->execute([':t' => $now, ':d' => $meDid, ':n' => ($note === '' ? null : $note), ':g' => $groupId, ':p' => $postId]);
                        if ($st->rowCount() < 1) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Post not pending'], 409);
                        }

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.post.deny',
                            ':sub' => (string)$postId,
                            ':det' => json_encode(['note' => ($note === '' ? null : $note)], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'postId' => $postId, 'state' => 'denied']);
                }

                case 'groupMembersList': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $state = isset($params['state']) ? trim((string)$params['state']) : '';
                    if ($state !== '' && !in_array($state, ['member', 'pending', 'blocked', 'invited'], true)) {
                        return $this->json(['error' => 'Invalid state'], 400);
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $meDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $curState = (string)($mr['state'] ?? '');
                        $curRole = (string)($mr['role'] ?? '');
                        if ($curState !== 'member' || !in_array($curRole, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $stHave = $pdo->prepare('SELECT group_id FROM groups WHERE group_id = :g LIMIT 1');
                    $stHave->execute([':g' => $groupId]);
                    if ($stHave->fetchColumn() === false) return $this->json(['error' => 'Group not found'], 404);

                    if ($state !== '') {
                        $st = $pdo->prepare('SELECT member_did, state, role, joined_at, created_at, updated_at,
                            warn_count, last_warned_at, last_warn_note, suspended_until, suspend_note, banned_at, ban_note
                            FROM group_members WHERE group_id = :g AND state = :s ORDER BY created_at ASC');
                        $st->execute([':g' => $groupId, ':s' => $state]);
                    } else {
                        $st = $pdo->prepare('SELECT member_did, state, role, joined_at, created_at, updated_at,
                            warn_count, last_warned_at, last_warn_note, suspended_until, suspend_note, banned_at, ban_note
                            FROM group_members WHERE group_id = :g ORDER BY created_at ASC');
                        $st->execute([':g' => $groupId]);
                    }
                    $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'state' => ($state ?: null), 'members' => $rows]);
                }

                case 'groupMemberApprove': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT state, role FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        $row = $stHave->fetch(\PDO::FETCH_ASSOC);
                        if (!$row) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }
                        $curState = (string)($row['state'] ?? '');
                        if ($curState === 'blocked') {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Member is blocked'], 409);
                        }

                        $pdo->prepare('UPDATE group_members SET state = "member", joined_at = COALESCE(joined_at, :t), updated_at = :t WHERE group_id = :g AND member_did = :did')
                            ->execute([':g' => $groupId, ':did' => $memberDid, ':t' => $now]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.approve',
                            ':sub' => $memberDid,
                            ':det' => json_encode(['prevState' => $curState], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                        return $this->json(['ok' => true]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupMemberDeny': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT state FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        $curState = $stHave->fetchColumn();
                        if ($curState === false) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }
                        $curState = (string)$curState;

                        if ($curState === 'member') {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Cannot deny an active member'], 409);
                        }

                        // Deny means remove the pending request (does not block).
                        $pdo->prepare('DELETE FROM group_members WHERE group_id = :g AND member_did = :did')
                            ->execute([':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.deny',
                            ':sub' => $memberDid,
                            ':det' => json_encode(['prevState' => $curState], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                        return $this->json(['ok' => true]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupMemberWarn': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $note = isset($params['note']) ? trim((string)$params['note']) : null;

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT member_did FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        if ($stHave->fetchColumn() === false) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }

                        $pdo->prepare('UPDATE group_members
                            SET warn_count = COALESCE(warn_count, 0) + 1,
                                last_warned_at = :t,
                                last_warn_note = :n,
                                updated_at = :t
                            WHERE group_id = :g AND member_did = :did')
                            ->execute([':t' => $now, ':n' => ($note === '' ? null : $note), ':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.warn',
                            ':sub' => $memberDid,
                            ':det' => json_encode(['note' => ($note === '' ? null : $note)], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $stOut = $pdo->prepare('SELECT member_did, state, role, joined_at, created_at, updated_at,
                            warn_count, last_warned_at, last_warn_note, suspended_until, suspend_note, banned_at, ban_note
                            FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stOut->execute([':g' => $groupId, ':did' => $memberDid]);
                        $member = $stOut->fetch(\PDO::FETCH_ASSOC);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'member' => $member]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupMemberSuspend': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $until = isset($params['until']) ? trim((string)$params['until']) : '';
                    $seconds = isset($params['suspendSeconds']) ? (int)$params['suspendSeconds'] : 0;
                    $note = isset($params['note']) ? trim((string)$params['note']) : null;

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    if ($seconds < 0) $seconds = 0;
                    if ($seconds > 86400 * 365) $seconds = 86400 * 365;

                    $untilIso = '';
                    if ($seconds > 0) {
                        $untilIso = gmdate('c', time() + $seconds);
                    } else {
                        if ($until === '') return $this->json(['error' => 'Missing until or suspendSeconds'], 400);
                        $ts = strtotime($until);
                        if (!$ts) return $this->json(['error' => 'Invalid until'], 400);
                        if ($ts <= time()) return $this->json(['error' => 'until must be in the future'], 400);
                        $untilIso = gmdate('c', $ts);
                    }

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT member_did FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        if ($stHave->fetchColumn() === false) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }

                        $pdo->prepare('UPDATE group_members
                            SET suspended_until = :u,
                                suspend_note = :n,
                                updated_at = :t
                            WHERE group_id = :g AND member_did = :did')
                            ->execute([':u' => $untilIso, ':n' => ($note === '' ? null : $note), ':t' => $now, ':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.suspend',
                            ':sub' => $memberDid,
                            ':det' => json_encode(['until' => $untilIso, 'note' => ($note === '' ? null : $note)], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $stOut = $pdo->prepare('SELECT member_did, state, role, joined_at, created_at, updated_at,
                            warn_count, last_warned_at, last_warn_note, suspended_until, suspend_note, banned_at, ban_note
                            FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stOut->execute([':g' => $groupId, ':did' => $memberDid]);
                        $member = $stOut->fetch(\PDO::FETCH_ASSOC);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'member' => $member]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupMemberUnsuspend': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT member_did FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        if ($stHave->fetchColumn() === false) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }

                        $pdo->prepare('UPDATE group_members
                            SET suspended_until = NULL,
                                suspend_note = NULL,
                                updated_at = :t
                            WHERE group_id = :g AND member_did = :did')
                            ->execute([':t' => $now, ':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.unsuspend',
                            ':sub' => $memberDid,
                            ':det' => null,
                            ':t' => $now,
                        ]);

                        $stOut = $pdo->prepare('SELECT member_did, state, role, joined_at, created_at, updated_at,
                            warn_count, last_warned_at, last_warn_note, suspended_until, suspend_note, banned_at, ban_note
                            FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stOut->execute([':g' => $groupId, ':did' => $memberDid]);
                        $member = $stOut->fetch(\PDO::FETCH_ASSOC);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'member' => $member]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupMemberBan': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $note = isset($params['note']) ? trim((string)$params['note']) : null;

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT member_did FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        if ($stHave->fetchColumn() === false) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }

                        $pdo->prepare('UPDATE group_members
                            SET state = "blocked",
                                banned_at = :t,
                                ban_note = :n,
                                suspended_until = NULL,
                                suspend_note = NULL,
                                updated_at = :t
                            WHERE group_id = :g AND member_did = :did')
                            ->execute([':t' => $now, ':n' => ($note === '' ? null : $note), ':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.ban',
                            ':sub' => $memberDid,
                            ':det' => json_encode(['note' => ($note === '' ? null : $note)], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $stOut = $pdo->prepare('SELECT member_did, state, role, joined_at, created_at, updated_at,
                            warn_count, last_warned_at, last_warn_note, suspended_until, suspend_note, banned_at, ban_note
                            FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stOut->execute([':g' => $groupId, ':did' => $memberDid]);
                        $member = $stOut->fetch(\PDO::FETCH_ASSOC);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'member' => $member]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupMemberUnban': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT member_did FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        if ($stHave->fetchColumn() === false) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }

                        // Unban does not auto-rejoin; member can join again.
                        $pdo->prepare('UPDATE group_members
                            SET state = "",
                                role = "member",
                                joined_at = NULL,
                                banned_at = NULL,
                                ban_note = NULL,
                                updated_at = :t
                            WHERE group_id = :g AND member_did = :did')
                            ->execute([':t' => $now, ':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.unban',
                            ':sub' => $memberDid,
                            ':det' => null,
                            ':t' => $now,
                        ]);

                        $stOut = $pdo->prepare('SELECT member_did, state, role, joined_at, created_at, updated_at,
                            warn_count, last_warned_at, last_warn_note, suspended_until, suspend_note, banned_at, ban_note
                            FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stOut->execute([':g' => $groupId, ':did' => $memberDid]);
                        $member = $stOut->fetch(\PDO::FETCH_ASSOC);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'groupId' => $groupId, 'member' => $member]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupMemberInvite': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT state, banned_at FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        $row = $stHave->fetch(\PDO::FETCH_ASSOC);
                        if ($row) {
                            $curState = (string)($row['state'] ?? '');
                            $bannedAt = (string)($row['banned_at'] ?? '');
                            if ($curState === 'member') {
                                $pdo->rollBack();
                                return $this->json(['error' => 'User is already a member'], 409);
                            }
                            if ($curState === 'blocked' || $bannedAt !== '') {
                                $pdo->rollBack();
                                return $this->json(['error' => 'User is blocked/banned'], 409);
                            }
                        }

                        $pdo->prepare('INSERT INTO group_members(group_id, member_did, state, role, joined_at, created_at, updated_at)
                            VALUES(:g,:did,"invited","member",NULL,:t,:t)
                            ON CONFLICT(group_id, member_did) DO UPDATE SET state=excluded.state, role=excluded.role, joined_at=NULL, updated_at=excluded.updated_at')
                            ->execute([':g' => $groupId, ':did' => $memberDid, ':t' => $now]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.invite',
                            ':sub' => $memberDid,
                            ':det' => null,
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'memberDid' => $memberDid, 'state' => 'invited']);
                }

                case 'groupMemberInviteRevoke': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '') return $this->json(['error' => 'Missing groupId or memberDid'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    if (!$meIsSuper) {
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $role = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || !in_array($role, ['admin', 'moderator'], true)) {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT state FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        $curState = $stHave->fetchColumn();
                        if ($curState === false) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }
                        $curState = (string)$curState;
                        if ($curState !== 'invited') {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Not an invited member'], 409);
                        }

                        $pdo->prepare('DELETE FROM group_members WHERE group_id = :g AND member_did = :did')
                            ->execute([':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.invite.revoke',
                            ':sub' => $memberDid,
                            ':det' => null,
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true]);
                }

                case 'groupMemberSetRole': {
                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    $memberDid = trim((string)($params['memberDid'] ?? ''));
                    $role = trim((string)($params['role'] ?? ''));
                    if ($groupId <= 0 || $memberDid === '' || $role === '') return $this->json(['error' => 'Missing groupId, memberDid, or role'], 400);
                    if (!in_array($role, ['member', 'moderator'], true)) return $this->json(['error' => 'Invalid role'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $meIsSuper = false;
                    if (!empty($jwt['ok']) && !empty($jwt['isSuper'])) {
                        $meIsSuper = true;
                    } else {
                        try {
                            $u = new User();
                            if ($u->isRegistered()) {
                                $ui = UserInfo::getByID((int)$u->getUserID());
                                $meIsSuper = $ui && method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
                            }
                        } catch (\Throwable $e) {
                            $meIsSuper = false;
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stG = $pdo->prepare('SELECT 1 FROM groups WHERE group_id = :g LIMIT 1');
                    $stG->execute([':g' => $groupId]);
                    if (!$stG->fetchColumn()) return $this->json(['error' => 'Group not found'], 404);

                    if (!$meIsSuper) {
                        // Role management is admin-only (moderators can't promote/demote).
                        $stRole = $pdo->prepare('SELECT gm.state, gm.role FROM group_members gm WHERE gm.group_id = :g AND gm.member_did = :me LIMIT 1');
                        $stRole->execute([':g' => $groupId, ':me' => $actorDid]);
                        $mr = $stRole->fetch(\PDO::FETCH_ASSOC);
                        $state = (string)($mr['state'] ?? '');
                        $myRole = (string)($mr['role'] ?? '');
                        if ($state !== 'member' || $myRole !== 'admin') {
                            return $this->json(['error' => 'Admin required'], 403);
                        }
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $stHave = $pdo->prepare('SELECT state, role FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stHave->execute([':g' => $groupId, ':did' => $memberDid]);
                        $row = $stHave->fetch(\PDO::FETCH_ASSOC);
                        if (!$row) {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Membership not found'], 404);
                        }
                        $curState = (string)($row['state'] ?? '');
                        $curRole = (string)($row['role'] ?? '');
                        if ($curState === 'blocked') {
                            $pdo->rollBack();
                            return $this->json(['error' => 'Member is blocked'], 409);
                        }
                        if ($curRole === $role) {
                            $pdo->rollBack();
                            return $this->json(['ok' => true, 'updated' => 0]);
                        }

                        $pdo->prepare('UPDATE group_members SET role = :r, updated_at = :t WHERE group_id = :g AND member_did = :did')
                            ->execute([':r' => $role, ':t' => $now, ':g' => $groupId, ':did' => $memberDid]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.member.role.set',
                            ':sub' => $memberDid,
                            ':det' => json_encode(['prevRole' => $curRole, 'role' => $role], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'updated' => 1]);
                }

                case 'groupInviteCreate': {
                    // MVP: invite links are admin-only.
                    $this->requireSuperUser($jwt);

                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $expiresInSeconds = isset($params['expiresInSeconds']) ? (int)$params['expiresInSeconds'] : 0;
                    if ($expiresInSeconds < 0) $expiresInSeconds = 0;
                    if ($expiresInSeconds > 0 && $expiresInSeconds < 60) $expiresInSeconds = 60;

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $stHave = $pdo->prepare('SELECT group_id FROM groups WHERE group_id = :g LIMIT 1');
                    $stHave->execute([':g' => $groupId]);
                    if ($stHave->fetchColumn() === false) return $this->json(['error' => 'Group not found'], 404);

                    $token = bin2hex(random_bytes(16));
                    $hash = hash('sha256', $token);
                    $hint = substr($token, 0, 6);
                    $now = gmdate('c');
                    $expiresAt = ($expiresInSeconds > 0) ? gmdate('c', time() + $expiresInSeconds) : null;

                    $pdo->beginTransaction();
                    try {
                        // Rotate: revoke all previous active invites for this group.
                        $pdo->prepare('UPDATE group_invites SET revoked_at = :t WHERE group_id = :g AND revoked_at IS NULL')
                            ->execute([':g' => $groupId, ':t' => $now]);

                        $pdo->prepare('INSERT INTO group_invites(group_id, token_hash, token_hint, created_by_did, created_at, expires_at, revoked_at)
                            VALUES(:g,:h,:hint,:by,:t,:exp,NULL)')
                            ->execute([':g' => $groupId, ':h' => $hash, ':hint' => $hint, ':by' => $actorDid, ':t' => $now, ':exp' => $expiresAt]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.invite.create',
                            ':sub' => (string)$groupId,
                            ':det' => json_encode(['tokenHint' => $hint, 'expiresAt' => $expiresAt], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json([
                        'ok' => true,
                        'groupId' => $groupId,
                        'token' => $token,
                        'tokenHint' => $hint,
                        'expiresAt' => $expiresAt,
                    ]);
                }

                case 'groupInvitesList': {
                    // MVP: invite visibility is admin-only.
                    $this->requireSuperUser($jwt);

                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $st = $pdo->prepare('SELECT invite_id, token_hint, created_by_did, created_at, expires_at, revoked_at
                        FROM group_invites
                        WHERE group_id = :g
                        ORDER BY created_at DESC
                        LIMIT 25');
                    $st->execute([':g' => $groupId]);
                    $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                    return $this->json(['ok' => true, 'groupId' => $groupId, 'invites' => $rows]);
                }

                case 'groupInviteRevoke': {
                    // MVP: invite rotation/revocation is admin-only.
                    $this->requireSuperUser($jwt);

                    $groupId = isset($params['groupId']) ? (int)$params['groupId'] : 0;
                    if ($groupId <= 0) return $this->json(['error' => 'Missing groupId'], 400);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $st = $pdo->prepare('UPDATE group_invites SET revoked_at = :t WHERE group_id = :g AND revoked_at IS NULL');
                        $st->execute([':g' => $groupId, ':t' => $now]);
                        $revoked = $st->rowCount();

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $actorDid,
                            ':act' => 'group.invite.revoke',
                            ':sub' => (string)$groupId,
                            ':det' => json_encode(['revoked' => $revoked], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                        return $this->json(['ok' => true, 'revoked' => $revoked]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'groupInviteJoin': {
                    // Join a group using an invite token. (Works for secret groups.)
                    $token = trim((string)($params['token'] ?? ''));
                    if ($token === '') return $this->json(['error' => 'Missing token'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $hash = hash('sha256', $token);
                    $stInv = $pdo->prepare('SELECT group_id, revoked_at, expires_at FROM group_invites WHERE token_hash = :h LIMIT 1');
                    $stInv->execute([':h' => $hash]);
                    $inv = $stInv->fetch(\PDO::FETCH_ASSOC);
                    if (!$inv) return $this->json(['error' => 'Invalid invite token'], 403);
                    if (!empty($inv['revoked_at'])) return $this->json(['error' => 'Invite token revoked'], 403);
                    if (!empty($inv['expires_at'])) {
                        $expTs = strtotime((string)$inv['expires_at']);
                        if ($expTs && $expTs <= time()) return $this->json(['error' => 'Invite token expired'], 403);
                    }

                    $groupId = (int)($inv['group_id'] ?? 0);
                    if ($groupId <= 0) return $this->json(['error' => 'Invite token invalid'], 403);

                    // Banned users cannot accept invites.
                    try {
                        $stBan = $pdo->prepare('SELECT state, banned_at FROM group_members WHERE group_id = :g AND member_did = :did LIMIT 1');
                        $stBan->execute([':g' => $groupId, ':did' => $meDid]);
                        $banRow = $stBan->fetch(\PDO::FETCH_ASSOC);
                        $banState = (string)($banRow['state'] ?? '');
                        $banAt = (string)($banRow['banned_at'] ?? '');
                        if ($banState === 'blocked' || $banAt !== '') {
                            return $this->json(['error' => 'You are banned from this group', 'code' => 'banned'], 403);
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    $now = gmdate('c');
                    $pdo->beginTransaction();
                    try {
                        $pdo->prepare('INSERT INTO group_members(group_id, member_did, state, role, joined_at, created_at, updated_at)
                            VALUES(:g,:did,"member","member",:t,:t,:t)
                            ON CONFLICT(group_id, member_did) DO UPDATE SET state=excluded.state, joined_at=excluded.joined_at, updated_at=excluded.updated_at')
                            ->execute([':g' => $groupId, ':did' => $meDid, ':t' => $now]);

                        $pdo->prepare('INSERT INTO group_audit(group_id, actor_did, action, subject, detail, created_at)
                            VALUES(:g,:a,:act,:sub,:det,:t)')->execute([
                            ':g' => $groupId,
                            ':a' => $meDid,
                            ':act' => 'group.invite.join',
                            ':sub' => $meDid,
                            ':det' => json_encode(['via' => 'invite'], JSON_UNESCAPED_SLASHES),
                            ':t' => $now,
                        ]);

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json(['ok' => true, 'groupId' => $groupId, 'state' => 'member']);
                }

                /* ===================== actor/profile ===================== */

                case 'getProfile':
                    // Single profile (defaults to the current session DID).
                    // Fast path: return cached profile if it's fresh enough.
                    $actor = (string)($params['actor'] ?? ($session['did'] ?? ''));
                    if ($actor === '') return $this->json(['error' => 'Missing actor'], 400);

                    $staleMinutes = (int)($params['staleMinutes'] ?? 10);
                    if ($staleMinutes < 1) $staleMinutes = 1;

                    try {
                        $pdo = $this->cacheDb();
                        $this->cacheMigrate($pdo);
                        $st = $pdo->prepare('SELECT raw_json, updated_at FROM profiles WHERE did = :did LIMIT 1');
                        $st->execute([':did' => $actor]);
                        $row = $st->fetch(\PDO::FETCH_ASSOC);
                        if ($row && !empty($row['raw_json']) && !empty($row['updated_at'])) {
                            $age = time() - (int)strtotime((string)$row['updated_at']);
                            if ($age >= 0 && $age <= ($staleMinutes * 60)) {
                                $cached = json_decode((string)$row['raw_json'], true);
                                if (is_array($cached) && !empty($cached['did'])) {
                                    return $this->json($cached);
                                }
                            }
                        }
                    } catch (\Throwable $e) {
                        // ignore cache failures; fall back to network
                    }

                    $prof = $this->xrpcSession('GET', 'app.bsky.actor.getProfile', $session, ['actor' => $actor]);
                    try {
                        $pdo = $this->cacheDb();
                        $this->cacheMigrate($pdo);
                        if (is_array($prof)) $this->cacheUpsertProfile($pdo, $prof);
                    } catch (\Throwable $e) {
                        // ignore
                    }
                    return $this->json($prof);

                case 'profileUpdate': {
                    // Update the current actor's profile record.
                    // Uses com.atproto.repo.putRecord on collection app.bsky.actor.profile with rkey "self".
                    // Params (all optional):
                    // - displayName: string|null (empty string clears)
                    // - description: string|null (empty string clears)
                    // - avatarBlob: object|null (blob ref from uploadBlob)
                    // - bannerBlob: object|null (blob ref from uploadBlob)
                    // - clearAvatar: bool
                    // - clearBanner: bool

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $displayNameIn = $params['displayName'] ?? null;
                    $descriptionIn = $params['description'] ?? null;

                    $avatarBlob = $params['avatarBlob'] ?? null;
                    $bannerBlob = $params['bannerBlob'] ?? null;

                    $clearAvatar = !empty($params['clearAvatar']);
                    $clearBanner = !empty($params['clearBanner']);

                    // Load existing record to preserve unknown fields where possible.
                    $existing = null;
                    try {
                        $existing = $this->xrpcSession('GET', 'com.atproto.repo.getRecord', $session, [
                            'repo' => $meDid,
                            'collection' => 'app.bsky.actor.profile',
                            'rkey' => 'self',
                        ]);
                    } catch (\Throwable $e) {
                        $existing = null;
                    }

                    $record = [];
                    if (is_array($existing) && isset($existing['value']) && is_array($existing['value'])) {
                        $record = $existing['value'];
                    }
                    if (!is_array($record)) $record = [];
                    $record['$type'] = 'app.bsky.actor.profile';

                    if ($displayNameIn !== null) {
                        $dn = trim((string)$displayNameIn);
                        if ($dn === '') unset($record['displayName']);
                        else $record['displayName'] = $dn;
                    }

                    if ($descriptionIn !== null) {
                        $desc = trim((string)$descriptionIn);
                        if ($desc === '') unset($record['description']);
                        else $record['description'] = $desc;
                    }

                    if ($clearAvatar) {
                        unset($record['avatar']);
                    } elseif (is_array($avatarBlob) && $avatarBlob) {
                        $record['avatar'] = $avatarBlob;
                    }

                    if ($clearBanner) {
                        unset($record['banner']);
                    } elseif (is_array($bannerBlob) && $bannerBlob) {
                        $record['banner'] = $bannerBlob;
                    }

                    $put = $this->xrpcSession('POST', 'com.atproto.repo.putRecord', $session, [], [
                        'repo' => $meDid,
                        'collection' => 'app.bsky.actor.profile',
                        'rkey' => 'self',
                        'record' => $record,
                    ]);

                    // Refresh profile + cache for immediate UI parity.
                    $prof = $this->xrpcSession('GET', 'app.bsky.actor.getProfile', $session, ['actor' => $meDid]);
                    try {
                        $pdo = $this->cacheDb();
                        $this->cacheMigrate($pdo);
                        if (is_array($prof)) $this->cacheUpsertProfile($pdo, $prof);
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    return $this->json(['ok' => true, 'put' => $put, 'profile' => $prof]);
                }

                case 'getProfiles': { // batch with chunking (>25 safe)
                    $actors = $params['actors'] ?? [];
                    if (!is_array($actors) || !$actors) return $this->json(['error' => 'Missing actors[]'], 400);
                    $actors = array_values(array_unique(array_filter(array_map('strval', $actors))));
                    $profiles = [];
                    foreach ($this->chunkArray($actors, 25) as $chunk) {
                        $resp = $this->xrpcSession('GET', 'app.bsky.actor.getProfiles',
                            $session, ['actors' => $chunk]);
                        foreach (($resp['profiles'] ?? []) as $p) {
                            $did = $p['did'] ?? null;
                            if ($did) $profiles[$did] = $p; // de-dupe by DID
                        }
                    }
                    return $this->json(['profiles' => array_values($profiles)]);
                }

                case 'profilesHydrate': {
                    // Hydrate profiles into SQLite (so followersCount/followsCount/postsCount are available).
                    // Params:
                    // - dids: string[]
                    // - staleHours: only refresh if updated_at older than this (default 24)
                    // - max: cap input size (default 200)
                    $dids = $params['dids'] ?? [];
                    if (!is_array($dids) || !$dids) return $this->json(['error' => 'Missing dids[]'], 400);
                    $max = min(500, max(1, (int)($params['max'] ?? 200)));
                    $staleHours = min(24 * 90, max(1, (int)($params['staleHours'] ?? 24)));

                    $dids = array_values(array_unique(array_filter(array_map('strval', $dids))));
                    if (count($dids) > $max) $dids = array_slice($dids, 0, $max);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // Determine which DIDs are stale/missing.
                    $need = [];
                    $have = [];
                    try {
                        $ph = [];
                        $bind = [];
                        foreach ($dids as $i => $did) {
                            $k = ':d' . $i;
                            $ph[] = $k;
                            $bind[$k] = $did;
                        }
                        $st = $pdo->prepare('SELECT did, updated_at FROM profiles WHERE did IN (' . implode(',', $ph) . ')');
                        $st->execute($bind);
                        foreach (($st->fetchAll(\PDO::FETCH_ASSOC) ?: []) as $r) {
                            if (!empty($r['did'])) {
                                $have[(string)$r['did']] = !empty($r['updated_at']) ? (string)$r['updated_at'] : null;
                            }
                        }
                    } catch (\Throwable $e) {
                        $have = [];
                    }

                    foreach ($dids as $did) {
                        $u = $have[$did] ?? null;
                        if (!$u) { $need[] = $did; continue; }
                        $age = time() - (int)strtotime($u);
                        if ($age < 0 || $age > ($staleHours * 3600)) $need[] = $did;
                    }

                    $updated = 0;
                    foreach ($this->chunkArray($need, 25) as $chunk) {
                        $resp = $this->xrpcSession('GET', 'app.bsky.actor.getProfiles', $session, ['actors' => $chunk]);
                        foreach (($resp['profiles'] ?? []) as $p) {
                            if (is_array($p)) {
                                $this->cacheUpsertProfile($pdo, $p);
                                $updated++;
                            }
                        }
                    }

                    return $this->json([
                        'ok' => true,
                        'requested' => count($dids),
                        'staleHours' => $staleHours,
                        'needed' => count($need),
                        'updated' => $updated,
                    ]);
                }

                case 'cacheGetProfiles': {
                    // Fetch cached profile rows by DID. Useful for UI refresh after profilesHydrate.
                    // Params:
                    // - dids: string[]
                    // - max: cap input size (default 200, max 500)
                    $dids = $params['dids'] ?? [];
                    if (!is_array($dids) || !$dids) return $this->json(['error' => 'Missing dids[]'], 400);
                    $max = min(500, max(1, (int)($params['max'] ?? 200)));

                    $dids = array_values(array_unique(array_filter(array_map('strval', $dids))));
                    if (count($dids) > $max) $dids = array_slice($dids, 0, $max);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    return $this->json([
                        'ok' => true,
                        'profiles' => $this->cacheLoadProfiles($pdo, $dids),
                    ]);
                }

                case 'searchActors':
                    // Typeahead / search
                    $q = (string)($params['q'] ?? '');
                    if ($q === '') return $this->json(['error' => 'Missing q'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.actor.searchActors',
                        $session, [
                            'q'      => $q,
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                /* ===================== feed / posts ===================== */

                case 'getTimeline':
                    // Home timeline
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.getTimeline',
                        $session, [
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getAuthorFeed':
                    // IMPORTANT: pass through optional "filter" so UI can request posts_with_replies, posts_no_replies, etc.
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.getAuthorFeed',
                        $session, [
                            'actor'  => $params['actor'] ?? ($session['did'] ?? null),
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                            'filter' => isset($params['filter']) ? (string)$params['filter'] : null, // <-- passthrough
                        ]));

                case 'getPosts': {
                    // Batch fetch posts by URI (chunked to 25 URIs per call to backend)
                    $uris = $params['uris'] ?? [];
                    if (!is_array($uris) || !$uris) return $this->json(['error' => 'Missing uris[]'], 400);
                    $uris = array_values(array_unique(array_filter(array_map('strval', $uris))));
                    $out = [];
                    foreach ($this->chunkArray($uris, 25) as $chunk) {
                        $resp = $this->xrpcSession('GET', 'app.bsky.feed.getPosts',
                            $session, ['uris' => $chunk]);
                        foreach (($resp['posts'] ?? []) as $p) {
                            $out[] = $p;
                        }
                    }
                    return $this->json(['posts' => $out]);
                }

                case 'getPostThread':
                    // For replies tab / lightbox; returns root + nested replies (tree)
                    $uri = (string)($params['uri'] ?? '');
                    if ($uri === '') return $this->json(['error' => 'Missing uri'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.getPostThread',
                        $session, [
                            'uri'           => $uri,
                            'depth'         => (int)($params['depth'] ?? 6),
                            'parentHeight'  => (int)($params['parentHeight'] ?? 0),
                        ]));

                case 'searchPosts':
                    $q = (string)($params['q'] ?? '');
                    if ($q === '') return $this->json(['error' => 'Missing q'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.searchPosts',
                        $session, [
                            'q'      => $q,
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getFeed':
                    // Custom feed generator URI
                    $feed = (string)($params['feed'] ?? '');
                    if ($feed === '') return $this->json(['error' => 'Missing feed'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.getFeed',
                        $session, [
                            'feed'   => $feed,
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                /* ---- post/like/repost CRUD (your repo) ---- */

                case 'uploadBlob': {
                    // Upload a blob (images first). Client sends base64 payload to avoid multipart handling.
                    $mime = trim((string)($params['mime'] ?? ''));
                    $b64  = (string)($params['dataBase64'] ?? '');
                    if ($mime === '' || $b64 === '') return $this->json(['error' => 'Missing mime/dataBase64'], 400);

                    // Safety: limit to images for now.
                    if (stripos($mime, 'image/') !== 0) {
                        return $this->json(['error' => 'Unsupported mime (images only for now)'], 400);
                    }

                    $bin = base64_decode($b64, true);
                    if ($bin === false) return $this->json(['error' => 'Invalid base64'], 400);

                    // Size guard (keep conservative; PDS may enforce smaller limits).
                    $max = (int)($params['maxBytes'] ?? 0);
                    if ($max <= 0) $max = 2 * 1024 * 1024;
                    if (strlen($bin) > $max) return $this->json(['error' => 'File too large'], 413);

                    $url = rtrim((string)$this->pds, '/') . '/xrpc/com.atproto.repo.uploadBlob';
                    $authType = (string)($session['authType'] ?? 'password');

                    if ($authType === 'oauth') {
                        $out = $this->oauthXrpcRaw('POST', $url, $session, $bin, $mime);
                        return $this->json($out);
                    }

                    $headers = [
                        'Authorization: Bearer ' . (string)($session['accessJwt'] ?? ''),
                        'Accept: application/json',
                    ];
                    $r = $this->httpRaw('POST', $url, $bin, $headers, $mime);
                    if (($r['status'] ?? 500) >= 400) {
                        $msg = is_array($r['json']) ? ($r['json']['message'] ?? ($r['json']['error'] ?? json_encode($r['json']))) : (string)($r['text'] ?? '');
                        throw new \RuntimeException('HTTP ' . (int)($r['status'] ?? 500) . ': ' . $msg);
                    }
                    return $this->json($r['json'] ?? ['raw' => (string)($r['text'] ?? '')]);
                }

                case 'createPost': {
                    // Used for inline reply from the modal; also supports a plain new post
                    $text = (string)($params['text'] ?? '');
                    if ($text === '') return $this->json(['error' => 'Missing text'], 400);
                    $record = [
                        '$type'     => 'app.bsky.feed.post',
                        'text'      => $text,
                        'createdAt' => gmdate('c'),
                    ];
                    if (!empty($params['langs']) && is_array($params['langs'])) $record['langs'] = array_values($params['langs']);
                    if (!empty($params['facets']) && is_array($params['facets'])) $record['facets'] = $params['facets'];
                    if (!empty($params['reply']) && is_array($params['reply']))   $record['reply']  = $params['reply']; // { root:{uri,cid}, parent:{uri,cid} }
                    if (!empty($params['embed']) && is_array($params['embed']))   $record['embed']  = $params['embed'];
                    return $this->json($this->createRecord($session, 'app.bsky.feed.post', $record));
                }

                case 'editPost': {
                    // Overwrite an existing post record in *your* repo.
                    // NOTE: app.bsky.feed.post has only createdAt; edits are represented by record overwrite.
                    $uri = trim((string)($params['uri'] ?? ''));
                    $rkey = trim((string)($params['rkey'] ?? ''));
                    if ($rkey === '' && $uri !== '') $rkey = (string)$this->rkeyFromAtUri($uri);
                    if ($rkey === '') return $this->json(['error' => 'Missing rkey/uri'], 400);

                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    if ($uri !== '') {
                        $prefix = 'at://' . $meDid . '/app.bsky.feed.post/';
                        if (!str_starts_with($uri, $prefix)) {
                            return $this->json(['error' => 'Can only edit your own posts'], 403);
                        }
                    }

                    $text = (string)($params['text'] ?? '');
                    if (trim($text) === '') return $this->json(['error' => 'Missing text'], 400);

                    // Fetch existing record to preserve reply/embed/createdAt/labels/etc.
                    $got = $this->xrpcSession('GET', 'com.atproto.repo.getRecord',
                        $session, [
                            'repo' => $meDid,
                            'collection' => 'app.bsky.feed.post',
                            'rkey' => $rkey,
                        ]
                    );

                    $old = null;
                    if (isset($got['value']) && is_array($got['value'])) $old = $got['value'];
                    if ($old === null && isset($got['record']) && is_array($got['record'])) $old = $got['record'];
                    if ($old === null) return $this->json(['error' => 'Post record not found'], 404);

                    $rec = $old;
                    $rec['$type'] = 'app.bsky.feed.post';
                    $rec['text'] = $text;

                    // Allow client to set/clear facets/langs explicitly.
                    if (array_key_exists('facets', $params)) {
                        if (is_array($params['facets'])) $rec['facets'] = $params['facets'];
                        else unset($rec['facets']);
                    }
                    if (array_key_exists('langs', $params)) {
                        if (is_array($params['langs'])) $rec['langs'] = array_values($params['langs']);
                        else unset($rec['langs']);
                    }

                    // Ensure createdAt exists.
                    if (empty($rec['createdAt'])) $rec['createdAt'] = gmdate('c');

                    $out = $this->xrpcSession('POST', 'com.atproto.repo.putRecord',
                        $session, [], [
                            'repo' => $meDid,
                            'collection' => 'app.bsky.feed.post',
                            'rkey' => $rkey,
                            'record' => $rec,
                        ]
                    );
                    return $this->json($out);
                }

                case 'translateText': {
                    $this->loadDotEnvOnce();

                    $backend = strtolower(trim($this->envStr('CONCRETESKY_TRANSLATE_BACKEND', 'none')));
                    if ($backend === '' || $backend === 'none' || $backend === 'off' || $backend === 'disabled') {
                        return $this->json([
                            'error' => 'Translation backend not configured',
                            'hint' => 'Set CONCRETESKY_TRANSLATE_BACKEND in .env (e.g. libretranslate).',
                        ], 501);
                    }

                    $text = (string)($params['text'] ?? '');
                    if (trim($text) === '') return $this->json(['error' => 'Missing text'], 400);
                    if (strlen($text) > 10000) return $this->json(['error' => 'Text too long'], 413);

                    $to = strtolower(trim((string)($params['to'] ?? '')));
                    if ($to === '') $to = 'en';
                    if (!preg_match('/^[a-z]{2,3}$/', $to)) return $this->json(['error' => 'Invalid target language'], 400);

                    $from = strtolower(trim((string)($params['from'] ?? '')));
                    if ($from !== '' && $from !== 'auto' && !preg_match('/^[a-z]{2,3}$/', $from)) {
                        return $this->json(['error' => 'Invalid source language'], 400);
                    }
                    if ($from === '') $from = 'auto';

                    if ($backend === 'libretranslate') {
                        $base = rtrim(trim($this->envStr('CONCRETESKY_TRANSLATE_LIBRETRANSLATE_URL', '')), '/');
                        if ($base === '') {
                            return $this->json([
                                'error' => 'LibreTranslate URL not configured',
                                'hint' => 'Set CONCRETESKY_TRANSLATE_LIBRETRANSLATE_URL in .env.',
                            ], 501);
                        }

                        $apiKey = trim($this->envStr('CONCRETESKY_TRANSLATE_LIBRETRANSLATE_API_KEY', ''));
                        $payload = [
                            'q' => $text,
                            'source' => $from,
                            'target' => $to,
                            'format' => 'text',
                        ];
                        if ($apiKey !== '') $payload['api_key'] = $apiKey;

                        $r = $this->httpRaw('POST', $base . '/translate', $payload, ['Accept: application/json'], 'application/x-www-form-urlencoded');
                        if (($r['status'] ?? 500) >= 400) {
                            $msg = is_array($r['json']) ? ($r['json']['error'] ?? ($r['json']['message'] ?? json_encode($r['json']))) : (string)($r['text'] ?? '');
                            throw new \RuntimeException('Translate failed (HTTP ' . (int)($r['status'] ?? 500) . '): ' . $msg);
                        }

                        $translated = '';
                        if (is_array($r['json'])) {
                            $translated = (string)($r['json']['translatedText'] ?? '');
                        }
                        if (trim($translated) === '') {
                            // Some instances return different shapes; fall back to raw text if needed.
                            $translated = is_string($r['text'] ?? null) ? (string)$r['text'] : '';
                        }

                        return $this->json([
                            'translatedText' => $translated,
                            'to' => $to,
                            'from' => $from,
                            'backend' => 'libretranslate',
                        ]);
                    }

                    return $this->json([
                        'error' => 'Unsupported translation backend',
                        'backend' => $backend,
                    ], 501);
                }

                case 'schedulePost': {
                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $scheduledAtIn = trim((string)($params['scheduledAt'] ?? ''));
                    if ($scheduledAtIn === '') return $this->json(['error' => 'Missing scheduledAt'], 400);
                    $ts = $this->parseIsoToTimestamp($scheduledAtIn);
                    if ($ts === null) return $this->json(['error' => 'Invalid scheduledAt'], 400);

                    $now = time();
                    if ($ts <= ($now + 10)) {
                        return $this->json(['error' => 'scheduledAt must be in the future'], 400);
                    }

                    $kind = strtolower(trim((string)($params['kind'] ?? 'post')));
                    if ($kind !== 'post' && $kind !== 'thread') $kind = 'post';

                    // We store a "ready-to-publish" payload (facets/embed already built client-side).
                    $payload = ['v' => 1];
                    $interactions = (isset($params['interactions']) && is_array($params['interactions'])) ? $params['interactions'] : null;
                    if (is_array($interactions)) $payload['interactions'] = $interactions;

                    if ($kind === 'thread') {
                        $partsIn = (isset($params['parts']) && is_array($params['parts'])) ? $params['parts'] : [];
                        $parts = [];
                        foreach (array_slice($partsIn, 0, 10) as $p) {
                            if (!is_array($p)) continue;
                            $text = trim((string)($p['text'] ?? ''));
                            if ($text === '') continue;
                            $part = ['text' => $text];
                            if (!empty($p['langs']) && is_array($p['langs'])) $part['langs'] = array_values($p['langs']);
                            if (!empty($p['facets']) && is_array($p['facets'])) $part['facets'] = $p['facets'];
                            if (!empty($p['embed']) && is_array($p['embed'])) $part['embed'] = $p['embed'];
                            $parts[] = $part;
                        }
                        if (!$parts) return $this->json(['error' => 'Missing parts'], 400);
                        $payload['parts'] = $parts;
                    } else {
                        $postIn = (isset($params['post']) && is_array($params['post'])) ? $params['post'] : null;
                        if (!is_array($postIn)) return $this->json(['error' => 'Missing post'], 400);
                        $text = trim((string)($postIn['text'] ?? ''));
                        if ($text === '') return $this->json(['error' => 'Missing text'], 400);
                        $post = ['text' => $text];
                        if (!empty($postIn['langs']) && is_array($postIn['langs'])) $post['langs'] = array_values($postIn['langs']);
                        if (!empty($postIn['facets']) && is_array($postIn['facets'])) $post['facets'] = $postIn['facets'];
                        if (!empty($postIn['embed']) && is_array($postIn['embed'])) $post['embed'] = $postIn['embed'];
                        $payload['post'] = $post;
                    }

                    $payloadJson = json_encode($payload, JSON_UNESCAPED_SLASHES);
                    if ($payloadJson === false) return $this->json(['error' => 'Failed to encode payload'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $scheduledIso = gmdate('c', $ts);
                    $nowIso = gmdate('c');

                    $st = $pdo->prepare('INSERT INTO scheduled_posts(actor_did, state, kind, scheduled_at, payload_json, attempts, last_error, next_attempt_at, result_uri, result_cid, created_at, updated_at)
                        VALUES(:a, "pending", :k, :s, :p, 0, NULL, NULL, NULL, NULL, :c, :u)');
                    $st->execute([
                        ':a' => $meDid,
                        ':k' => $kind,
                        ':s' => $scheduledIso,
                        ':p' => $payloadJson,
                        ':c' => $nowIso,
                        ':u' => $nowIso,
                    ]);

                    $id = (int)$pdo->lastInsertId();
                    return $this->json(['ok' => true, 'id' => $id, 'scheduledAt' => $scheduledIso, 'kind' => $kind]);
                }

                case 'listScheduledPosts': {
                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);
                    $limit = (int)($params['limit'] ?? 50);
                    $includeDone = !empty($params['includeDone']);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);
                    $items = $this->scheduledPostsListInternal($pdo, $meDid, $limit, $includeDone);
                    return $this->json(['ok' => true, 'items' => $items]);
                }

                case 'cancelScheduledPost': {
                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $id = (int)($params['id'] ?? 0);
                    if ($id <= 0) return $this->json(['error' => 'Missing id'], 400);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $nowIso = gmdate('c');
                    $st = $pdo->prepare('UPDATE scheduled_posts
                        SET state="canceled", updated_at=:u
                        WHERE actor_did=:a AND id=:id AND state IN ("pending","posting")');
                    $st->execute([':u' => $nowIso, ':a' => $meDid, ':id' => $id]);

                    return $this->json(['ok' => true, 'canceled' => $st->rowCount() > 0]);
                }

                case 'processScheduledPosts': {
                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);
                    $max = (int)($params['max'] ?? 25);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $out = $this->processScheduledPostsInternal($pdo, $session, $meDid, $max);
                    return $this->json($out);
                }

                case 'createThreadGate': {
                    // Create a threadgate record for a post (reply controls).
                    // NOTE: per lexicon, rkey of threadgate must match the post rkey.
                    $postUri = (string)($params['postUri'] ?? '');
                    if ($postUri === '') return $this->json(['error' => 'Missing postUri'], 400);
                    $rkey = $this->rkeyFromAtUri($postUri);
                    if (!$rkey) return $this->json(['error' => 'Could not determine rkey'], 400);

                    $allowIn = $params['allow'] ?? null;
                    $allow = null;
                    if (is_array($allowIn)) {
                        $allow = [];
                        foreach ($allowIn as $rule) {
                            $t = strtolower(trim((string)$rule));
                            if ($t === 'mention' || $t === 'mentions' || $t === 'mentionrule') {
                                $allow[] = ['$type' => 'app.bsky.feed.threadgate#mentionRule'];
                            } elseif ($t === 'follower' || $t === 'followers' || $t === 'followerrule') {
                                $allow[] = ['$type' => 'app.bsky.feed.threadgate#followerRule'];
                            } elseif ($t === 'following' || $t === 'followingrule') {
                                $allow[] = ['$type' => 'app.bsky.feed.threadgate#followingRule'];
                            } elseif ($t === 'list' || $t === 'listrule') {
                                $listUri = (string)($params['listUri'] ?? '');
                                if ($listUri === '') return $this->json(['error' => 'Missing listUri for list rule'], 400);
                                $allow[] = ['$type' => 'app.bsky.feed.threadgate#listRule', 'list' => $listUri];
                            }
                        }
                    }

                    $record = [
                        '$type'     => 'app.bsky.feed.threadgate',
                        'post'      => $postUri,
                        'createdAt' => gmdate('c'),
                    ];
                    if ($allow !== null) {
                        // If allow is an empty array, no one can reply.
                        $record['allow'] = array_values($allow);
                    }
                    return $this->json($this->createRecord($session, 'app.bsky.feed.threadgate', $record, $rkey));
                }

                case 'createPostGate': {
                    // Create a postgate record for a post (quote/embedding controls).
                    // NOTE: per lexicon, rkey of postgate must match the post rkey.
                    $postUri = (string)($params['postUri'] ?? '');
                    if ($postUri === '') return $this->json(['error' => 'Missing postUri'], 400);
                    $rkey = $this->rkeyFromAtUri($postUri);
                    if (!$rkey) return $this->json(['error' => 'Could not determine rkey'], 400);

                    $disableEmbedding = (bool)($params['disableEmbedding'] ?? false);
                    $record = [
                        '$type'     => 'app.bsky.feed.postgate',
                        'post'      => $postUri,
                        'createdAt' => gmdate('c'),
                    ];
                    if ($disableEmbedding) {
                        $record['embeddingRules'] = [
                            ['$type' => 'app.bsky.feed.postgate#disableRule'],
                        ];
                    }

                    return $this->json($this->createRecord($session, 'app.bsky.feed.postgate', $record, $rkey));
                }

                case 'deletePost': {
                    $rkey = (string)($params['rkey'] ?? '');
                    $uri  = (string)($params['uri'] ?? '');
                    if (!$rkey && !$uri) return $this->json(['error' => 'Missing rkey/uri'], 400);
                    if (!$rkey && $uri) $rkey = $this->rkeyFromAtUri($uri);
                    if (!$rkey) return $this->json(['error' => 'Could not determine rkey'], 400);
                    return $this->json($this->deleteRecord($session, 'app.bsky.feed.post', $rkey));
                }

                case 'like': {
                    // Create a like for subject {uri,cid}
                    $uri = (string)($params['uri'] ?? '');
                    $cid = (string)($params['cid'] ?? '');
                    if (!$uri || !$cid) return $this->json(['error' => 'Missing uri/cid'], 400);
                    $rec = ['subject' => ['uri' => $uri, 'cid' => $cid], 'createdAt' => gmdate('c')];
                    return $this->json($this->createRecord($session, 'app.bsky.feed.like', $rec));
                }

                case 'unlike': {
                    // Find existing like record matching the post (and optional CID) and delete it
                    $uri = (string)($params['uri'] ?? '');
                    $cid = isset($params['cid']) ? (string)$params['cid'] : null;
                    if (!$uri) return $this->json(['error' => 'Missing uri'], 400);
                    $rkey = $this->findEngagementRkey($session, 'app.bsky.feed.like', $uri, $cid);
                    if (!$rkey) return $this->json(['error' => 'Like record not found'], 404);
                    return $this->json($this->deleteRecord($session, 'app.bsky.feed.like', $rkey));
                }

                case 'repost': {
                    $uri = (string)($params['uri'] ?? '');
                    $cid = (string)($params['cid'] ?? '');
                    if (!$uri || !$cid) return $this->json(['error' => 'Missing uri/cid'], 400);
                    $rec = ['subject' => ['uri' => $uri, 'cid' => $cid], 'createdAt' => gmdate('c')];
                    return $this->json($this->createRecord($session, 'app.bsky.feed.repost', $rec));
                }

                case 'unrepost': {
                    $uri = (string)($params['uri'] ?? '');
                    $cid = isset($params['cid']) ? (string)$params['cid'] : null;
                    if (!$uri) return $this->json(['error' => 'Missing uri'], 400);
                    $rkey = $this->findEngagementRkey($session, 'app.bsky.feed.repost', $uri, $cid);
                    if (!$rkey) return $this->json(['error' => 'Repost record not found'], 404);
                    return $this->json($this->deleteRecord($session, 'app.bsky.feed.repost', $rkey));
                }

                case 'listMyLikeRecords': {
                    $limit = min(100, max(1, (int)($params['limit'] ?? 50)));
                    $cursor = isset($params['cursor']) ? (string)$params['cursor'] : null;
                    return $this->json($this->listRecords($session, 'app.bsky.feed.like', $limit, $cursor));
                }

                case 'listMyRepostRecords': {
                    $limit = min(100, max(1, (int)($params['limit'] ?? 50)));
                    $cursor = isset($params['cursor']) ? (string)$params['cursor'] : null;
                    return $this->json($this->listRecords($session, 'app.bsky.feed.repost', $limit, $cursor));
                }

                /* ---- per-post context (for interactions modal) ---- */

                case 'getLikes':
                    if (empty($params['uri'])) return $this->json(['error' => 'Missing uri'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.getLikes',
                        $session, [
                            'uri'    => $params['uri'],
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getRepostedBy':
                    if (empty($params['uri'])) return $this->json(['error' => 'Missing uri'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.getRepostedBy',
                        $session, [
                            'uri'    => $params['uri'],
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getQuotes':
                    if (empty($params['uri'])) return $this->json(['error' => 'Missing uri'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.feed.getQuotes',
                        $session, [
                            'uri'    => $params['uri'],
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                /* ===================== graph / follow & social state ===================== */

                case 'getFollowers':
                    return $this->json($this->xrpcSession('GET', 'app.bsky.graph.getFollowers',
                        $session, [
                            'actor'  => $params['actor'] ?? ($session['did'] ?? null),
                            'limit'  => (int)($params['limit'] ?? 50),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getFollows':
                    return $this->json($this->xrpcSession('GET', 'app.bsky.graph.getFollows',
                        $session, [
                            'actor'  => $params['actor'] ?? ($session['did'] ?? null),
                            'limit'  => (int)($params['limit'] ?? 50),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getKnownFollowers': {
                    // “Followers you know” parity.
                    // Prefer app.bsky.graph.getKnownFollowers (if supported by the AppView).
                    // Params:
                    // - actor: did or handle (required)
                    // - limit: max people to return (default 10, max 50)
                    // - cursor: pass-through (only used for the native endpoint)
                    // - pagesMax: fallback cap for pagination (default 10, max 50)
                    $actor = trim((string)($params['actor'] ?? ''));
                    if ($actor === '') return $this->json(['error' => 'Missing actor'], 400);

                    $limit = (int)($params['limit'] ?? 10);
                    if ($limit < 1) $limit = 1;
                    if ($limit > 50) $limit = 50;

                    $cursor = isset($params['cursor']) ? (string)$params['cursor'] : null;
                    $pagesMax = (int)($params['pagesMax'] ?? 10);
                    if ($pagesMax < 1) $pagesMax = 1;
                    if ($pagesMax > 50) $pagesMax = 50;

                    // 1) Native endpoint.
                    try {
                        $res = $this->xrpcSession('GET', 'app.bsky.graph.getKnownFollowers', $session, [
                            'actor' => $actor,
                            'limit' => $limit,
                            'cursor' => $cursor,
                        ]);
                        if (is_array($res)) {
                            $res['ok'] = true;
                            $res['source'] = 'app.bsky.graph.getKnownFollowers';
                        }
                        return $this->json($res);
                    } catch (\Throwable $e) {
                        // fallback below
                    }

                    // 2) Best-effort fallback: intersect actor followers with viewer's following set.
                    $meDid = (string)($session['did'] ?? '');
                    if ($meDid === '') return $this->json(['error' => 'Could not determine session DID'], 500);

                    $myFollowing = [];
                    $warnings = [];

                    // Prefer SQLite cache for viewer following set.
                    try {
                        $pdo = $this->cacheDb();
                        $this->cacheMigrate($pdo);
                        $snap = $this->cacheMetaGet($pdo, $meDid, 'last_snapshot_following');
                        $sid = $snap ? (int)$snap : 0;
                        if ($sid > 0) {
                            $st = $pdo->prepare('SELECT other_did FROM edges WHERE snapshot_id = :sid AND kind = "following"');
                            $st->execute([':sid' => $sid]);
                            $myFollowing = array_values(array_unique(array_filter(array_map('strval', $st->fetchAll(\PDO::FETCH_COLUMN) ?: []))));
                        } else {
                            $warnings[] = 'No cached following snapshot. Run cacheSync to improve fallback results.';
                        }
                    } catch (\Throwable $e) {
                        $warnings[] = 'SQLite cache unavailable for following set; using network fallback.';
                        $myFollowing = [];
                    }

                    // If no cache following set, build from network (bounded).
                    if (!$myFollowing) {
                        $followSet = [];
                        $cur = null;
                        for ($i = 0; $i < $pagesMax; $i++) {
                            $page = $this->xrpcSession('GET', 'app.bsky.graph.getFollows', $session, [
                                'actor' => $meDid,
                                'limit' => 100,
                                'cursor' => $cur,
                            ]);
                            foreach (($page['follows'] ?? []) as $p) {
                                $did = is_array($p) ? (string)($p['did'] ?? '') : '';
                                if ($did !== '') $followSet[$did] = true;
                            }
                            $cur = isset($page['cursor']) ? (string)$page['cursor'] : null;
                            if (!$cur) break;
                        }
                        $myFollowing = array_keys($followSet);
                        if (!$myFollowing) {
                            return $this->json([
                                'ok' => false,
                                'error' => 'Could not determine your following set (cache missing and network fallback returned none).',
                                'warnings' => $warnings,
                            ], 503);
                        }
                    }

                    $myFollowingSet = array_fill_keys($myFollowing, true);

                    $out = [];
                    $cur = null;
                    for ($i = 0; $i < $pagesMax && count($out) < $limit; $i++) {
                        $page = $this->xrpcSession('GET', 'app.bsky.graph.getFollowers', $session, [
                            'actor' => $actor,
                            'limit' => 100,
                            'cursor' => $cur,
                        ]);
                        $batch = $page['followers'] ?? [];
                        foreach ($batch as $p) {
                            if (!is_array($p)) continue;
                            $did = (string)($p['did'] ?? '');
                            if ($did === '' || empty($myFollowingSet[$did])) continue;
                            $out[$did] = $p;
                            if (count($out) >= $limit) break;
                        }
                        $cur = isset($page['cursor']) ? (string)$page['cursor'] : null;
                        if (!$cur) break;
                    }

                    $followers = array_values($out);

                    // Opportunistically store returned profiles for richer cache-first rendering elsewhere.
                    try {
                        $pdo = $this->cacheDb();
                        $this->cacheMigrate($pdo);
                        foreach ($followers as $p) {
                            if (is_array($p)) $this->cacheUpsertProfile($pdo, $p);
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    return $this->json([
                        'ok' => true,
                        'source' => 'computed',
                        'actor' => $actor,
                        'followers' => $followers,
                        'limit' => $limit,
                        'warnings' => $warnings,
                    ]);
                }

                case 'getBlocks':
                    return $this->json($this->xrpcSession('GET', 'app.bsky.graph.getBlocks',
                        $session, [
                            'limit'  => (int)($params['limit'] ?? 50),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getMutes':
                    return $this->json($this->xrpcSession('GET', 'app.bsky.graph.getMutes',
                        $session, [
                            'limit'  => (int)($params['limit'] ?? 50),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getLists':
                    return $this->json($this->xrpcSession('GET', 'app.bsky.graph.getLists',
                        $session, [
                            'actor'  => $params['actor'] ?? ($session['did'] ?? null),
                            'limit'  => (int)($params['limit'] ?? 50),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'getList':
                    // Fetch list details + members.
                    // Params:
                    // - list: at://... URI (preferred)
                    // - limit/cursor
                    $listUri = (string)($params['list'] ?? $params['uri'] ?? '');
                    $listUri = trim($listUri);
                    if ($listUri === '') return $this->json(['error' => 'Missing list'], 400);
                    return $this->json($this->xrpcSession('GET', 'app.bsky.graph.getList',
                        $session, [
                            'list'   => $listUri,
                            'limit'  => (int)($params['limit'] ?? 50),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'listsIncludingActor': {
                    // Lists that include an actor (optional; only if server exposes a compatible endpoint).
                    // Params:
                    // - actor: did or handle
                    // - limit/cursor
                    $actor = trim((string)($params['actor'] ?? ''));
                    if ($actor === '') $actor = (string)($session['did'] ?? '');
                    if ($actor === '') return $this->json(['error' => 'Missing actor'], 400);

                    $limit = (int)($params['limit'] ?? 50);
                    $cursor = $params['cursor'] ?? null;

                    $warnings = [];
                    $attempts = [
                        // Best-effort guesses; different appviews may expose different names.
                        ['nsid' => 'app.bsky.graph.getListsContainingActor', 'params' => ['actor' => $actor, 'limit' => $limit, 'cursor' => $cursor]],
                        ['nsid' => 'app.bsky.graph.getListsContainingActor', 'params' => ['did' => $actor, 'limit' => $limit, 'cursor' => $cursor]],
                        ['nsid' => 'app.bsky.unspecced.getListsContainingActor', 'params' => ['actor' => $actor, 'limit' => $limit, 'cursor' => $cursor]],
                    ];

                    foreach ($attempts as $a) {
                        try {
                            $res = $this->xrpcSession('GET', (string)$a['nsid'], $session, (array)$a['params']);
                            return $this->json([
                                'ok' => true,
                                'actor' => $actor,
                                'source' => (string)$a['nsid'],
                                'result' => $res,
                                'warnings' => array_values(array_unique($warnings)),
                            ]);
                        } catch (\Throwable $e) {
                            $warnings[] = 'Not available: ' . (string)$a['nsid'];
                        }
                    }

                    return $this->json([
                        'ok' => false,
                        'actor' => $actor,
                        'error' => 'This server does not expose a lists-including-actor endpoint.',
                        'warnings' => array_values(array_unique($warnings)),
                    ], 501);
                }

                case 'resolveHandles': {
                    // Batch resolve @handles to DIDs for richtext mention facets.
                    $handlesIn = $params['handles'] ?? null;
                    if (!is_array($handlesIn)) return $this->json(['error' => 'Missing handles'], 400);

                    $handles = [];
                    foreach ($handlesIn as $h) {
                        $s = trim((string)$h);
                        $s = ltrim($s, '@');
                        if ($s === '') continue;
                        $handles[] = $s;
                    }
                    $handles = array_values(array_unique($handles));
                    if (count($handles) > 50) $handles = array_slice($handles, 0, 50);

                    $dids = [];
                    $errors = [];
                    foreach ($handles as $h) {
                        $key = (string)$h;
                        try {
                            $did = $this->resolveActorDid($key, $session);
                            if ($did) $dids[$key] = $did;
                            else $errors[$key] = 'Unable to resolve';
                        } catch (\Throwable $e) {
                            $errors[$key] = $e->getMessage();
                        }
                    }

                    return $this->json(['dids' => (object)$dids, 'errors' => (object)$errors]);
                }

                case 'unfurlUrl': {
                    // Server-side unfurl for link cards (embed.external) to avoid browser CORS.
                    // Returns { embed: { $type:'app.bsky.embed.external', external:{ uri,title,description,thumb? } } }
                    $urlIn = trim((string)($params['url'] ?? ''));
                    if ($urlIn === '') return $this->json(['error' => 'Missing url'], 400);
                    if (!preg_match('#^https?://#i', $urlIn)) return $this->json(['error' => 'Only http/https URLs supported'], 400);

                    // Guard length.
                    if (strlen($urlIn) > 2048) return $this->json(['error' => 'URL too long'], 400);

                    $wantThumb = !isset($params['thumb']) ? true : (bool)$params['thumb'];

                    $fetch = function (string $url, int $timeoutSec = 6, int $maxBytes = 262144, array $headers = []) : array {
                        $respHeaders = [];
                        $ch = curl_init($url);
                        curl_setopt_array($ch, [
                            CURLOPT_RETURNTRANSFER => true,
                            CURLOPT_FOLLOWLOCATION => true,
                            CURLOPT_MAXREDIRS      => 4,
                            CURLOPT_CUSTOMREQUEST  => 'GET',
                            CURLOPT_TIMEOUT        => $timeoutSec,
                            CURLOPT_HTTPHEADER     => $headers,
                            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
                                $len = strlen($line);
                                try {
                                    $t = trim($line);
                                    if ($t === '' || stripos($t, 'HTTP/') === 0) return $len;
                                    $p = strpos($t, ':');
                                    if ($p === false) return $len;
                                    $k = strtolower(trim(substr($t, 0, $p)));
                                    $v = trim(substr($t, $p + 1));
                                    if ($k !== '') $respHeaders[$k] = $v;
                                } catch (\Throwable $e) {}
                                return $len;
                            },
                        ]);
                        $raw = curl_exec($ch);
                        if ($raw === false) {
                            $err = curl_error($ch);
                            curl_close($ch);
                            throw new \RuntimeException('Unfurl fetch failed: ' . $err);
                        }
                        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                        curl_close($ch);

                        if (is_string($raw) && strlen($raw) > $maxBytes) {
                            $raw = substr($raw, 0, $maxBytes);
                        }

                        return ['status' => $code, 'headers' => $respHeaders, 'body' => $raw];
                    };

                    $normalizeWs = function (string $s) : string {
                        $s = trim(preg_replace('/\s+/', ' ', $s));
                        return $s;
                    };

                    $absUrl = function (string $base, string $maybe) : string {
                        $maybe = trim($maybe);
                        if ($maybe === '') return '';
                        if (preg_match('#^https?://#i', $maybe)) return $maybe;
                        if (str_starts_with($maybe, '//')) {
                            try {
                                $b = parse_url($base);
                                $scheme = isset($b['scheme']) ? (string)$b['scheme'] : 'https';
                                return $scheme . ':' . $maybe;
                            } catch (\Throwable $e) {
                                return '';
                            }
                        }
                        try {
                            $b = parse_url($base);
                            $scheme = isset($b['scheme']) ? (string)$b['scheme'] : 'https';
                            $host = isset($b['host']) ? (string)$b['host'] : '';
                            if ($host === '') return '';
                            $port = isset($b['port']) ? (':' . (int)$b['port']) : '';
                            $origin = $scheme . '://' . $host . $port;
                            if (str_starts_with($maybe, '/')) return $origin . $maybe;
                            // relative path
                            $path = isset($b['path']) ? (string)$b['path'] : '/';
                            $dir = rtrim(str_replace('\\', '/', dirname($path)), '/');
                            return $origin . ($dir ? $dir . '/' : '/') . $maybe;
                        } catch (\Throwable $e) {
                            return '';
                        }
                    };

                    $r = $fetch($urlIn, 6, 262144, [
                        'Accept: text/html,application/xhtml+xml',
                        'User-Agent: ConcreteSky/1.0 (+https://theblobinc.com)',
                    ]);
                    if (($r['status'] ?? 500) >= 400) return $this->json(['error' => 'Unfurl HTTP ' . (int)($r['status'] ?? 500)], 400);
                    $html = (string)($r['body'] ?? '');
                    if ($html === '') return $this->json(['error' => 'Empty response'], 400);

                    // Extract <title> and OG tags.
                    $getMeta = function (string $html, array $keys) : string {
                        foreach ($keys as $k) {
                            $k = preg_quote($k, '/');
                            if (preg_match('/<meta[^>]+(?:property|name)=["\']' . $k . '["\'][^>]*content=["\']([^"\']+)["\'][^>]*>/i', $html, $m)) {
                                return (string)html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5);
                            }
                            if (preg_match('/<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' . $k . '["\'][^>]*>/i', $html, $m)) {
                                return (string)html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5);
                            }
                        }
                        return '';
                    };

                    $title = $normalizeWs($getMeta($html, ['og:title', 'twitter:title']));
                    if ($title === '' && preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $m)) {
                        $title = $normalizeWs((string)html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5));
                    }
                    $desc = $normalizeWs($getMeta($html, ['og:description', 'twitter:description', 'description']));
                    $img = $normalizeWs($getMeta($html, ['og:image', 'twitter:image']));
                    $img = $absUrl($urlIn, $img);

                    if ($title === '') $title = $urlIn;
                    if (strlen($title) > 300) $title = substr($title, 0, 300);
                    if (strlen($desc) > 1000) $desc = substr($desc, 0, 1000);

                    $thumbBlob = null;
                    if ($wantThumb && $img !== '') {
                        try {
                            $imgResp = $fetch($img, 6, 1048576, [
                                'Accept: image/*',
                                'User-Agent: ConcreteSky/1.0 (+https://theblobinc.com)',
                            ]);
                            if (($imgResp['status'] ?? 500) < 400) {
                                $ct = strtolower((string)($imgResp['headers']['content-type'] ?? ''));
                                $mime = (str_contains($ct, 'image/')) ? trim(explode(';', $ct)[0]) : '';
                                $bin = $imgResp['body'] ?? '';
                                if ($mime !== '' && is_string($bin) && strlen($bin) > 0 && strlen($bin) <= 1048576) {
                                    $upUrl = rtrim((string)$this->pds, '/') . '/xrpc/com.atproto.repo.uploadBlob';
                                    $authType = (string)($session['authType'] ?? 'password');
                                    if ($authType === 'oauth') {
                                        $out = $this->oauthXrpcRaw('POST', $upUrl, $session, $bin, $mime);
                                        $thumbBlob = $out['blob'] ?? ($out['data']['blob'] ?? null);
                                    } else {
                                        $headers = [
                                            'Authorization: Bearer ' . (string)($session['accessJwt'] ?? ''),
                                            'Accept: application/json',
                                        ];
                                        $up = $this->httpRaw('POST', $upUrl, $bin, $headers, $mime);
                                        if (($up['status'] ?? 500) < 400) {
                                            $thumbBlob = $up['json']['blob'] ?? ($up['json']['data']['blob'] ?? null);
                                        }
                                    }
                                }
                            }
                        } catch (\Throwable $e) {
                            // best-effort
                        }
                    }

                    $external = [
                        'uri' => $urlIn,
                        'title' => $title,
                        'description' => $desc,
                    ];
                    if ($thumbBlob) $external['thumb'] = $thumbBlob;

                    return $this->json([
                        'embed' => [
                            '$type' => 'app.bsky.embed.external',
                            'external' => $external,
                        ],
                        'meta' => [
                            'image' => $img,
                        ],
                    ]);
                }

                case 'getRelationships': { // batch with chunking + fallback (fixes >25 actor errors)
                    $actors = $params['actors'] ?? [];
                    if (!is_array($actors) || !$actors) return $this->json(['error' => 'Missing actors[]'], 400);
                    $actors = array_values(array_unique(array_filter(array_map('strval', $actors))));
                    $rels = [];

                    foreach ($this->chunkArray($actors, 25) as $chunk) {
                        try {
                            $resp = $this->xrpcSession('GET', 'app.bsky.graph.getRelationships',
                                $session, ['actors' => $chunk]);
                            foreach (($resp['relationships'] ?? []) as $r) {
                                $rels[] = $this->normalizeRelationship($r);
                            }
                        } catch (\Throwable $e) {
                            // Some deployments don’t have graph.getRelationships—fallback to getProfiles viewer flags
                            $p = $this->xrpcSession('GET', 'app.bsky.actor.getProfiles',
                                $session, ['actors' => $chunk]);
                            foreach (($p['profiles'] ?? []) as $prof) {
                                $rels[] = $this->relationshipFromProfile($prof);
                            }
                        }
                    }
                    return $this->json(['relationships' => $this->dedupeRelationships($rels)]);
                }

                case 'follow':
                    $did = (string)($params['did'] ?? '');
                    if (!$did) return $this->json(['error' => 'Missing did'], 400);
                    $rec = ['subject' => $did, 'createdAt' => gmdate('c')];
                    return $this->json($this->createRecord($session, 'app.bsky.graph.follow', $rec));

                case 'unfollow':
                    $did = (string)($params['did'] ?? '');
                    if (!$did) return $this->json(['error' => 'Missing did'], 400);
                    $rkey = $this->findFollowRkey($session, $did);
                    if (!$rkey) return $this->json(['error' => 'Follow record not found'], 404);
                    return $this->json($this->deleteRecord($session, 'app.bsky.graph.follow', $rkey));

                case 'block':
                    $did = (string)($params['did'] ?? '');
                    if (!$did) return $this->json(['error' => 'Missing did'], 400);
                    $rec = ['subject' => $did, 'createdAt' => gmdate('c')];
                    return $this->json($this->createRecord($session, 'app.bsky.graph.block', $rec));

                case 'unblock':
                    $did = (string)($params['did'] ?? '');
                    if (!$did) return $this->json(['error' => 'Missing did'], 400);
                    $rkey = $this->findBlockRkey($session, $did);
                    if (!$rkey) return $this->json(['error' => 'Block record not found'], 404);
                    return $this->json($this->deleteRecord($session, 'app.bsky.graph.block', $rkey));

                case 'mute':
                    $did = (string)($params['did'] ?? '');
                    if (!$did) return $this->json(['error' => 'Missing did'], 400);
                    return $this->json($this->xrpcSession('POST', 'app.bsky.graph.muteActor',
                        $session, [], ['actor' => $did]));

                case 'unmute':
                    $did = (string)($params['did'] ?? '');
                    if (!$did) return $this->json(['error' => 'Missing did'], 400);
                    return $this->json($this->xrpcSession('POST', 'app.bsky.graph.unmuteActor',
                        $session, [], ['actor' => $did]));

                /* ===================== interactions / notifications ===================== */

                case 'listNotifications':
                    return $this->json($this->xrpcSession('GET', 'app.bsky.notification.listNotifications',
                        $session, [
                            'limit'  => (int)($params['limit'] ?? 25),
                            'cursor' => $params['cursor'] ?? null,
                        ]));

                case 'updateSeenNotifications':
                    $seenAt = $params['seenAt'] ?? gmdate('c');
                    return $this->json($this->xrpcSession('POST', 'app.bsky.notification.updateSeen',
                        $session, [], ['seenAt' => $seenAt]));

                case 'getNotificationPreferences':
                    return $this->json($this->xrpcSession('GET', 'app.bsky.notification.getPreferences',
                        $session, []));

                case 'putNotificationPreferences': {
                    if (!array_key_exists('priority', $params)) return $this->json(['error' => 'Missing priority'], 400);
                    $priorityRaw = $params['priority'];
                    $priority = (is_bool($priorityRaw)) ? $priorityRaw : ((int)$priorityRaw !== 0);
                    return $this->json($this->xrpcSession('POST', 'app.bsky.notification.putPreferences',
                        $session, [], ['priority' => $priority]));
                }

                case 'getInteractionStats':
                    // Aggregates likes/replies by DID across pages of notifications
                    $days  = max(1, (int)($params['days'] ?? 90));
                    $pages = min(25, max(1, (int)($params['pages'] ?? 10)));

                    $myDid = $session['did'] ?? null;

                    $cursor = null;
                    $stats = [];
                    for ($i = 0; $i < $pages; $i++) {
                        $data = $this->xrpcSession('GET', 'app.bsky.notification.listNotifications', $session, [
                            'limit'  => 100,
                            'cursor' => $cursor,
                        ]);

                        foreach (($data['notifications'] ?? []) as $n) {
                            $author = $n['author'] ?? [];
                            $did = $author['did'] ?? null;
                            if (!$did) continue;

                            // Only count interactions on your own content
                            $subjectUri = $n['reasonSubject'] ?? null;
                            if ($subjectUri && $myDid) {
                                $didFromSubject = $this->didFromAtUri($subjectUri);
                                if ($didFromSubject && $didFromSubject !== $myDid) continue;
                            }

                            $reason = $n['reason'] ?? '';
                            if (!isset($stats[$did])) {
                                $stats[$did] = ['likes'=>0, 'replies'=>0, 'handle'=>$author['handle'] ?? '', 'displayName'=>$author['displayName'] ?? ''];
                            }
                            if ($reason === 'like')   $stats[$did]['likes']++;
                            if ($reason === 'reply')  $stats[$did]['replies']++;
                        }

                        $cursor = $data['cursor'] ?? null;
                        if (!$cursor) break;
                    }

                    return $this->json(['sinceDays' => $days, 'pages' => $pages, 'stats' => $stats]);

                /* ---- time-filtered notifications + bulk follow (UI: notifications column) ---- */

                case 'listNotificationsSince': {
                    // Server-side filtered notifications window used by UI filters
                    $hours    = max(1, (int)($params['hours'] ?? 24));
                    $reasons  = (isset($params['reasons']) && is_array($params['reasons'])) ? $params['reasons'] : null;
                    $pagesMax = min(30, max(1, (int)($params['pagesMax'] ?? 15)));

                    $cutoff = new \DateTimeImmutable("-{$hours} hours");
                    $cursor = $params['cursor'] ?? null;
                    $out = [];
                    for ($i = 0; $i < $pagesMax; $i++) {
                        $data = $this->xrpcSession('GET', 'app.bsky.notification.listNotifications', $session, [
                            'limit'  => 100,
                            'cursor' => $cursor,
                        ]);

                        $batch = $data['notifications'] ?? [];
                        if (!$batch) break;

                        foreach ($batch as $n) {
                            $ts = $n['indexedAt'] ?? $n['createdAt'] ?? null;
                            if ($ts) {
                                try {
                                    $dt = new \DateTimeImmutable($ts);
                                    if ($dt < $cutoff) {
                                        $cursor = null;
                                        break 2; // exit both foreach and for
                                    }
                                } catch (\Throwable $e) { /* ignore parse issues */ }
                            }
                            if ($reasons && !in_array(($n['reason'] ?? ''), $reasons, true)) continue;
                            $out[] = $n;
                        }

                        $cursor = $data['cursor'] ?? null;
                        if (!$cursor) break;
                    }

                    return $this->json(['notifications' => $out]);
                }

                case 'followMany': {
                    // Bulk follow (used by "Follow all shown" in notifications)
                    $dids = $params['dids'] ?? [];
                    if (!is_array($dids) || !$dids) return $this->json(['error' => 'Missing dids[]'], 400);

                    $results = [];
                    foreach (array_values(array_unique(array_map('strval', $dids))) as $did) {
                        try {
                            $rec = ['subject' => $did, 'createdAt' => gmdate('c')];
                            $resp = $this->createRecord($session, 'app.bsky.graph.follow', $rec);
                            $results[$did] = ['ok' => true, 'uri' => $resp['uri'] ?? null];
                        } catch (\Throwable $e) {
                            $results[$did] = ['ok' => false, 'error' => $e->getMessage()];
                        }
                    }
                    return $this->json(['results' => $results]);
                }

                case 'queueFollows': {
                    // Queue follows for later processing (rate-limit friendly bulk follow).
                    // Params:
                    // - dids: string[]
                    // - processNow: bool (default true)
                    // - maxNow: int (default 50)
                    $dids = $params['dids'] ?? [];
                    if (!is_array($dids) || !$dids) return $this->json(['error' => 'Missing dids[]'], 400);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Missing actor DID'], 500);

                    $processNow = (bool)($params['processNow'] ?? true);
                    $maxNow = min(500, max(1, (int)($params['maxNow'] ?? 50)));

                    $norm = [];
                    foreach ($dids as $d) {
                        $s = trim((string)$d);
                        if ($s !== '') $norm[$s] = true;
                    }
                    $unique = array_keys($norm);

                    $enqueued = 0;
                    $nowIso = gmdate('c');

                    $pdo->beginTransaction();
                    try {
                        $st = $pdo->prepare('INSERT OR IGNORE INTO follow_queue(actor_did,target_did,state,attempts,created_at,updated_at)
                            VALUES(:a,:t,"pending",0,:c,:u)');
                        foreach ($unique as $did) {
                            $st->execute([':a' => $actorDid, ':t' => $did, ':c' => $nowIso, ':u' => $nowIso]);
                            $enqueued += (int)$st->rowCount();
                        }
                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    $processed = null;
                    if ($processNow) {
                        $processed = $this->processFollowQueueInternal($pdo, $session, $actorDid, $maxNow);
                    }

                    $status = $this->followQueueStatusInternal($pdo, $actorDid);
                    return $this->json([
                        'ok' => true,
                        'actorDid' => $actorDid,
                        'enqueued' => $enqueued,
                        'unique' => count($unique),
                        'processed' => $processed,
                        'status' => $status,
                    ]);
                }

                case 'starterPackGet': {
                    // Starter packs (if supported by server).
                    // Params:
                    // - input: starter pack URL (bsky.app) or at:// URI
                    // - limit: member limit (best-effort; default 50)

                    $input = trim((string)($params['input'] ?? ''));
                    $limit = min(200, max(1, (int)($params['limit'] ?? 50)));
                    if ($input === '') return $this->json(['error' => 'Missing input'], 400);

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $normalize = static function (string $raw): ?string {
                        $raw = trim($raw);
                        if ($raw === '') return null;
                        if (stripos($raw, 'at://') === 0) return $raw;

                        // Accept bsky.app starter pack URLs.
                        // Expected shapes (best-effort):
                        // - https://bsky.app/starter-pack/{did}/{rkey}
                        // - https://bsky.app/starter-pack/{handle}/{rkey}
                        if (preg_match('~^https?://(?:www\.)?bsky\.app/starter-pack/([^/]+)/([^/?#]+)~i', $raw, $m)) {
                            $actor = trim((string)$m[1]);
                            $rkey = trim((string)$m[2]);
                            if ($actor !== '' && $rkey !== '') {
                                // NOTE: the collection name is best-effort; servers may accept this via getStarterPack.
                                return 'at://' . $actor . '/app.bsky.graph.starterpack/' . $rkey;
                            }
                        }

                        return null;
                    };

                    $uri = $normalize($input);
                    if (!$uri) {
                        return $this->json([
                            'ok' => false,
                            'error' => 'Unrecognized starter pack input. Paste a bsky.app starter pack URL or an at:// URI.',
                        ], 400);
                    }

                    $raw = null;
                    $members = null;
                    $warnings = [];

                    // Try common endpoints/parameter shapes.
                    $attempts = [
                        ['method' => 'GET', 'nsid' => 'app.bsky.graph.getStarterPack', 'params' => ['starterPack' => $uri]],
                        ['method' => 'GET', 'nsid' => 'app.bsky.graph.getStarterPack', 'params' => ['uri' => $uri]],
                    ];

                    foreach ($attempts as $a) {
                        try {
                            $raw = $this->xrpcSession((string)$a['method'], (string)$a['nsid'], $session, (array)$a['params']);
                            if ($raw) break;
                        } catch (\Throwable $e) {
                            $warnings[] = 'Starter pack endpoint not available: ' . (string)$a['nsid'];
                        }
                    }

                    if (!$raw) {
                        // Try a multi-fetch endpoint if present.
                        try {
                            $res = $this->xrpcSession('GET', 'app.bsky.graph.getStarterPacks', $session, ['uris' => [$uri]]);
                            if (is_array($res) && !empty($res['starterPacks'][0])) {
                                $raw = $res['starterPacks'][0];
                            }
                        } catch (\Throwable $e) {
                            // ignore
                        }
                    }

                    if (!$raw) {
                        return $this->json([
                            'ok' => false,
                            'error' => 'Starter packs are not supported by this server.',
                            'uri' => $uri,
                            'warnings' => array_values(array_unique($warnings)),
                        ], 501);
                    }

                    // Best-effort member list.
                    if (isset($raw['members']) && is_array($raw['members'])) {
                        $members = array_slice($raw['members'], 0, $limit);
                    } elseif (isset($raw['items']) && is_array($raw['items'])) {
                        $members = array_slice($raw['items'], 0, $limit);
                    } else {
                        // Some servers split members into a separate endpoint.
                        $memberAttempts = [
                            ['nsid' => 'app.bsky.graph.getStarterPackMembers', 'params' => ['starterPack' => $uri, 'limit' => $limit]],
                            ['nsid' => 'app.bsky.graph.getStarterPackMembers', 'params' => ['uri' => $uri, 'limit' => $limit]],
                        ];
                        foreach ($memberAttempts as $a) {
                            try {
                                $mres = $this->xrpcSession('GET', (string)$a['nsid'], $session, (array)$a['params']);
                                if (is_array($mres)) {
                                    if (isset($mres['members']) && is_array($mres['members'])) $members = array_slice($mres['members'], 0, $limit);
                                    elseif (isset($mres['items']) && is_array($mres['items'])) $members = array_slice($mres['items'], 0, $limit);
                                    elseif (isset($mres['profiles']) && is_array($mres['profiles'])) $members = array_slice($mres['profiles'], 0, $limit);
                                }
                                if ($members !== null) break;
                            } catch (\Throwable $e) {
                                // ignore
                            }
                        }
                    }

                    return $this->json([
                        'ok' => true,
                        'uri' => $uri,
                        'limit' => $limit,
                        'starterPack' => $raw,
                        'members' => $members,
                        'warnings' => array_values(array_unique($warnings)),
                    ]);
                }

                case 'followQueueStatus': {
                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);
                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Missing actor DID'], 500);
                    return $this->json(['ok' => true, 'actorDid' => $actorDid, 'status' => $this->followQueueStatusInternal($pdo, $actorDid)]);
                }

                case 'processFollowQueue': {
                    // Process queued follows up to `max`.
                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);
                    $actorDid = (string)($session['did'] ?? '');
                    if ($actorDid === '') return $this->json(['error' => 'Missing actor DID'], 500);
                    $max = min(500, max(1, (int)($params['max'] ?? 50)));
                    $out = $this->processFollowQueueInternal($pdo, $session, $actorDid, $max);
                    $out['status'] = $this->followQueueStatusInternal($pdo, $actorDid);
                    return $this->json($out);
                }

                /* ===================== local SQLite cache ===================== */

                case 'cacheSync': {
                    // Sync followers/following into local SQLite for fast sort/search + diffs.
                    // Params:
                    // - kind: 'followers' | 'following' | 'both' (default both)
                    // - kind: 'all' also includes notifications
                    // - pagesMax: max pages to fetch per list (default 50)
                    // - mode: 'auto' (skip if recently synced) | 'force'
                    // - notificationsHours: notification window to cache (default 720)
                    // - notificationsPagesMax: max notification pages (default 30)

                    $kind = (string)($params['kind'] ?? 'both');
                    $mode = (string)($params['mode'] ?? 'auto');
                    $pagesMax = min(200, max(1, (int)($params['pagesMax'] ?? 50)));
                    $notificationsHours = min(24 * 365 * 30, max(1, (int)($params['notificationsHours'] ?? 720)));
                    $notificationsPagesMax = min(60, max(1, (int)($params['notificationsPagesMax'] ?? 30)));

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // Auto mode: skip if last sync was recent
                    if ($mode === 'auto') {
                        $last = $this->cacheMetaGet($pdo, $meDid, 'last_sync_at');
                        if ($last) {
                            try {
                                $dt = new \DateTimeImmutable($last);
                                $age = time() - $dt->getTimestamp();
                                if ($age >= 0 && $age < 600) {
                                    return $this->json(['ok' => true, 'skipped' => true, 'reason' => 'recent', 'lastSyncAt' => $last]);
                                }
                            } catch (\Throwable $e) { /* ignore */ }
                        }
                    }

                    $pdo->beginTransaction();
                    try {
                        $now = gmdate('c');
                        $summary = ['ok' => true, 'skipped' => false, 'actorDid' => $meDid, 'syncedAt' => $now, 'followers' => null, 'following' => null, 'notifications' => null];

                        if ($kind === 'followers' || $kind === 'both') {
                            $summary['followers'] = $this->cacheSyncList($pdo, $session, $meDid, 'followers', $pagesMax);
                        }
                        if ($kind === 'following' || $kind === 'both') {
                            $summary['following'] = $this->cacheSyncList($pdo, $session, $meDid, 'following', $pagesMax);
                        }

                        if ($kind === 'all') {
                            $summary['followers'] = $this->cacheSyncList($pdo, $session, $meDid, 'followers', $pagesMax);
                            $summary['following'] = $this->cacheSyncList($pdo, $session, $meDid, 'following', $pagesMax);
                            $summary['notifications'] = $this->cacheSyncNotifications($pdo, $session, $meDid, $notificationsHours, $notificationsPagesMax);
                            $this->cacheMetaSet($pdo, $meDid, 'last_notifications_sync_at', $now);
                        }

                        $this->cacheMetaSet($pdo, $meDid, 'last_sync_at', $now);
                        $pdo->commit();

                        // Diff summary (added/removed) for followers by default
                        $diffFollowers = $this->cacheDiffLatestTwo($pdo, $meDid, 'followers');
                        $diffFollowing = $this->cacheDiffLatestTwo($pdo, $meDid, 'following');
                        $summary['diff'] = [
                            'followers' => $diffFollowers,
                            'following' => $diffFollowing,
                        ];

                        return $this->json($summary);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'cacheStatus': {
                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $meDid = $session['did'] ?? null;

                    // Backfill status helpers (best-effort, used for UI clarity).
                    $minNotifIso = null;
                    $minPostIso = null;
                    try {
                        $st = $pdo->prepare('SELECT MIN(indexed_at) FROM notifications WHERE actor_did = :a AND indexed_at IS NOT NULL');
                        $st->execute([':a' => $meDid]);
                        $v = $st->fetchColumn();
                        $minNotifIso = ($v !== false && $v !== null && (string)$v !== '') ? (string)$v : null;
                    } catch (\Throwable $e) {
                        $minNotifIso = null;
                    }
                    try {
                        $st = $pdo->prepare('SELECT MIN(created_at) FROM posts WHERE actor_did = :a AND created_at IS NOT NULL');
                        $st->execute([':a' => $meDid]);
                        $v = $st->fetchColumn();
                        $minPostIso = ($v !== false && $v !== null && (string)$v !== '') ? (string)$v : null;
                    } catch (\Throwable $e) {
                        $minPostIso = null;
                    }

                    $notifCursor = $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_cursor');
                    $notifStopBefore = $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_last_stop_before');
                    $notifDone = $notifCursor ? false : true;
                    $notifRetentionHint = false;
                    try {
                        if ($notifStopBefore && $minNotifIso) {
                            $s = strtotime($notifStopBefore);
                            $m = strtotime($minNotifIso);
                            if ($s !== false && $m !== false && $m > $s) {
                                $notifRetentionHint = true;
                            }
                        }
                    } catch (\Throwable $e) {
                        $notifRetentionHint = false;
                    }

                    $postsCursor = $this->cacheMetaGet($pdo, $meDid, 'posts_backfill_cursor');
                    $postsDoneFlag = $this->cacheMetaGet($pdo, $meDid, 'posts_backfill_done');

                    $status = [
                        'ok' => true,
                        'actorDid' => $meDid,
                        'lastSyncAt' => $this->cacheMetaGet($pdo, $meDid, 'last_sync_at'),
                        'lastNotificationsSyncAt' => $this->cacheMetaGet($pdo, $meDid, 'last_notifications_sync_at'),
                        'lastNotificationsSeenAt' => $this->cacheMetaGet($pdo, $meDid, 'last_notifications_seen_at'),
                        'lastPostsSyncAt' => $this->cacheMetaGet($pdo, $meDid, 'last_posts_sync_at'),
                        'lastPostsSeenAt' => $this->cacheMetaGet($pdo, $meDid, 'last_posts_seen_at'),
                        'backfill' => [
                            'notifications' => [
                                'cursor' => $notifCursor,
                                'done' => $notifDone,
                                'lastHours' => $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_last_hours'),
                                'lastStopBefore' => $notifStopBefore,
                                'lastCutoffIso' => $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_last_cutoff_iso'),
                                'lastOldestSeenIso' => $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_last_oldest_seen_iso'),
                                'lastRetentionLimited' => $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_last_retention_limited') === '1',
                                'lastDone' => $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_last_done') === '1',
                                'oldestCachedIso' => $minNotifIso,
                                'retentionHint' => $notifRetentionHint,
                            ],
                            'posts' => [
                                'cursor' => $postsCursor,
                                'done' => ($postsDoneFlag === '1') && !$postsCursor,
                                'lastStopBefore' => $this->cacheMetaGet($pdo, $meDid, 'posts_backfill_last_stop_before'),
                                'oldestCachedIso' => $minPostIso,
                            ],
                        ],
                        'snapshots' => [
                            'followers' => $this->cacheLatestSnapshotInfo($pdo, $meDid, 'followers'),
                            'following' => $this->cacheLatestSnapshotInfo($pdo, $meDid, 'following'),
                        ],
                        'diff' => [
                            'followers' => $this->cacheDiffLatestTwo($pdo, $meDid, 'followers', 0, false),
                            'following' => $this->cacheDiffLatestTwo($pdo, $meDid, 'following', 0, false),
                        ],
                        'notifications' => [
                            'cachedTotal' => $this->cacheNotificationsCount($pdo, $meDid),
                            'cachedLast30d' => $this->cacheNotificationsCountSince($pdo, $meDid, 24 * 30),
                        ],
                        'posts' => [
                            'cachedTotal' => $this->cachePostsCount($pdo, $meDid),
                            'cachedLast30d' => $this->cachePostsCountSince($pdo, $meDid, 24 * 30),
                        ],
                    ];

                    return $this->json($status);
                }

                /* ===================== people monitoring (watchlist) ===================== */

                case 'watchListList': {
                    $ownerDid = $session['did'] ?? null;
                    if (!$ownerDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $includeStats = (bool)($params['includeStats'] ?? true);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $st = $pdo->prepare('SELECT watched_did AS watchedDid, watched_handle AS watchedHandle, created_at AS createdAt, updated_at AS updatedAt, last_checked_at AS lastCheckedAt, last_seen_post_created_at AS lastSeenPostCreatedAt, last_seen_post_uri AS lastSeenPostUri FROM watchlist WHERE owner_did = :o ORDER BY COALESCE(updated_at, created_at) DESC');
                    $st->execute([':o' => $ownerDid]);
                    $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                    $dids = [];
                    foreach ($rows as $r) {
                        if (!empty($r['watchedDid'])) $dids[] = (string)$r['watchedDid'];
                    }

                    $profiles = $dids ? $this->cacheLoadProfiles($pdo, $dids) : [];

                    if ($includeStats && $dids) {
                        foreach ($rows as &$r) {
                            $did = (string)($r['watchedDid'] ?? '');
                            if ($did === '') continue;
                            $r['stats'] = [
                                'cachedTotalPosts' => $this->cachePostsCount($pdo, $did),
                                'cachedPosts24h' => $this->cachePostsCountSince($pdo, $did, 24),
                                'cachedPosts7d' => $this->cachePostsCountSince($pdo, $did, 24 * 7),
                            ];
                        }
                        unset($r);
                    }

                    return $this->json([
                        'ok' => true,
                        'ownerDid' => $ownerDid,
                        'watchlist' => $rows,
                        'profiles' => $profiles,
                    ]);
                }

                case 'watchListAdd': {
                    $ownerDid = $session['did'] ?? null;
                    if (!$ownerDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $actor = (string)($params['actor'] ?? '');
                    if ($actor === '') return $this->json(['error' => 'Missing actor'], 400);

                    $did = $this->resolveActorDid($session, $actor);

                    // Hydrate profile (best-effort) so UI can render name/avatar immediately.
                    $prof = null;
                    try {
                        $prof = $this->xrpcSession('GET', 'app.bsky.actor.getProfile', $session, ['actor' => $did]);
                    } catch (\Throwable $e) {
                        $prof = null;
                    }

                    $watchedHandle = null;
                    if (is_array($prof) && !empty($prof['handle'])) $watchedHandle = (string)$prof['handle'];

                    $prime = isset($params['prime']) ? (bool)$params['prime'] : true;
                    $primeSeenIso = null;
                    $primeSeenUri = null;
                    if ($prime) {
                        try {
                            $resp = $this->xrpcSession('GET', 'app.bsky.feed.getAuthorFeed', $session, [
                                'actor' => $did,
                                'limit' => 1,
                                'cursor' => null,
                                'filter' => isset($params['filter']) ? (string)$params['filter'] : null,
                            ]);
                            $item = $resp['feed'][0] ?? null;
                            if (is_array($item)) {
                                $primeSeenIso = $item['post']['record']['createdAt'] ?? null;
                                $primeSeenUri = $item['post']['uri'] ?? null;
                            }
                        } catch (\Throwable $e) {
                            // ignore
                        }
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (is_array($prof) && !empty($prof['did'])) {
                        try { $this->cacheUpsertProfile($pdo, $prof); } catch (\Throwable $e) { /* ignore */ }
                    }

                    $now = gmdate('c');
                    $st = $pdo->prepare('INSERT INTO watchlist(owner_did, watched_did, watched_handle, created_at, updated_at, last_checked_at, last_seen_post_created_at, last_seen_post_uri)
                        VALUES(:o,:d,:h,:c,:u,NULL,:s,:su)
                        ON CONFLICT(owner_did, watched_did) DO UPDATE SET
                          watched_handle=excluded.watched_handle,
                          updated_at=excluded.updated_at,
                          last_seen_post_created_at=CASE WHEN watchlist.last_seen_post_created_at IS NULL OR watchlist.last_seen_post_created_at = "" THEN excluded.last_seen_post_created_at ELSE watchlist.last_seen_post_created_at END,
                          last_seen_post_uri=CASE WHEN watchlist.last_seen_post_uri IS NULL OR watchlist.last_seen_post_uri = "" THEN excluded.last_seen_post_uri ELSE watchlist.last_seen_post_uri END');
                    $st->execute([
                        ':o' => $ownerDid,
                        ':d' => $did,
                        ':h' => $watchedHandle,
                        ':c' => $now,
                        ':u' => $now,
                        ':s' => $primeSeenIso,
                        ':su' => $primeSeenUri,
                    ]);

                    return $this->json([
                        'ok' => true,
                        'ownerDid' => $ownerDid,
                        'watchedDid' => $did,
                        'profile' => $prof,
                        'primedLastSeenAt' => $primeSeenIso,
                        'primedLastSeenUri' => $primeSeenUri,
                    ]);
                }

                case 'watchListRemove': {
                    $ownerDid = $session['did'] ?? null;
                    if (!$ownerDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $did = (string)($params['did'] ?? '');
                    if ($did === '') return $this->json(['error' => 'Missing did'], 400);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $st = $pdo->prepare('DELETE FROM watchlist WHERE owner_did = :o AND watched_did = :d');
                    $st->execute([':o' => $ownerDid, ':d' => $did]);
                    $removed = (int)$st->rowCount();

                    try {
                        $st2 = $pdo->prepare('DELETE FROM watch_events WHERE owner_did = :o AND watched_did = :d');
                        $st2->execute([':o' => $ownerDid, ':d' => $did]);
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    return $this->json(['ok' => true, 'removed' => $removed > 0]);
                }

                case 'watchCheck': {
                    $ownerDid = $session['did'] ?? null;
                    if (!$ownerDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $hours = min(24 * 30, max(1, (int)($params['hours'] ?? 72)));
                    $pagesMax = min(10, max(1, (int)($params['pagesMax'] ?? 2)));
                    $maxUsers = min(200, max(1, (int)($params['maxUsers'] ?? 50)));
                    $scanLimit = min(500, max(25, (int)($params['scanLimit'] ?? 200)));
                    $perUserMaxReturn = min(50, max(0, (int)($params['perUserMaxReturn'] ?? 15)));
                    $storeEvents = isset($params['storeEvents']) ? (bool)$params['storeEvents'] : true;

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $st = $pdo->prepare('SELECT watched_did, watched_handle, last_seen_post_created_at, last_seen_post_uri FROM watchlist WHERE owner_did = :o ORDER BY COALESCE(updated_at, created_at) DESC LIMIT :lim');
                    $st->bindValue(':o', $ownerDid);
                    $st->bindValue(':lim', $maxUsers, \PDO::PARAM_INT);
                    $st->execute();
                    $watchRows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                    $now = gmdate('c');
                    $filter = isset($params['filter']) ? (string)$params['filter'] : null;
                    $out = [];

                    $stUpdate = $pdo->prepare('UPDATE watchlist SET last_checked_at = :t, last_seen_post_created_at = :s, last_seen_post_uri = :u, updated_at = :t WHERE owner_did = :o AND watched_did = :d');
                    $stUpdateChecked = $pdo->prepare('UPDATE watchlist SET last_checked_at = :t, updated_at = :t WHERE owner_did = :o AND watched_did = :d');

                    $stEvents = null;
                    if ($storeEvents) {
                        $stEvents = $pdo->prepare('INSERT OR IGNORE INTO watch_events(owner_did, watched_did, post_uri, post_created_at, detected_at, raw_json)
                            VALUES(:o,:d,:u,:c,:t,:j)');
                    }

                    foreach ($watchRows as $w) {
                        $watchedDid = (string)($w['watched_did'] ?? '');
                        if ($watchedDid === '') continue;

                        $lastSeenIso = (string)($w['last_seen_post_created_at'] ?? '');
                        $lastSeenTs = $lastSeenIso !== '' ? strtotime($lastSeenIso) : null;

                        $sync = null;
                        try {
                            $sync = $this->cacheSyncMyPosts($pdo, $session, $watchedDid, $hours, $pagesMax, $filter);
                        } catch (\Throwable $e) {
                            $out[] = [
                                'watchedDid' => $watchedDid,
                                'watchedHandle' => $w['watched_handle'] ?? null,
                                'ok' => false,
                                'error' => $e->getMessage(),
                            ];
                            continue;
                        }

                        // Scan newest cached posts and compute new items since last seen.
                        $stPosts = $pdo->prepare('SELECT uri, created_at, raw_json FROM posts WHERE actor_did = :a ORDER BY created_at DESC LIMIT :lim');
                        $stPosts->bindValue(':a', $watchedDid);
                        $stPosts->bindValue(':lim', $scanLimit, \PDO::PARAM_INT);
                        $stPosts->execute();
                        $rows = $stPosts->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                        $newItemsDesc = [];
                        $newUris = [];
                        $newMaxTs = $lastSeenTs;
                        $newMaxIso = $lastSeenIso !== '' ? $lastSeenIso : null;
                        $newMaxUri = $w['last_seen_post_uri'] ?? null;

                        foreach ($rows as $r) {
                            $iso = (string)($r['created_at'] ?? '');
                            $ts = $iso !== '' ? strtotime($iso) : null;
                            if ($ts === null) continue;

                            // If not initialized yet, prime last-seen without emitting notifications.
                            if ($lastSeenTs === null) {
                                $newMaxTs = $ts;
                                $newMaxIso = $iso;
                                $newMaxUri = (string)($r['uri'] ?? '') ?: null;
                                break;
                            }

                            if ($ts <= $lastSeenTs) {
                                break; // sorted DESC
                            }

                            $uri = (string)($r['uri'] ?? '');
                            if ($uri !== '') $newUris[] = $uri;

                            if ($perUserMaxReturn > 0 && count($newItemsDesc) < $perUserMaxReturn) {
                                $raw = $r['raw_json'] ? json_decode((string)$r['raw_json'], true) : null;
                                if (is_array($raw)) {
                                    $newItemsDesc[] = $raw;
                                }
                            }

                            if ($newMaxTs === null || $ts > $newMaxTs) {
                                $newMaxTs = $ts;
                                $newMaxIso = $iso;
                                $newMaxUri = $uri ?: $newMaxUri;
                            }
                        }

                        // Persist event rows (best-effort).
                        if ($storeEvents && $stEvents && $newUris) {
                            foreach ($newUris as $uri) {
                                try {
                                    $stEvents->execute([
                                        ':o' => $ownerDid,
                                        ':d' => $watchedDid,
                                        ':u' => $uri,
                                        ':c' => null,
                                        ':t' => $now,
                                        ':j' => null,
                                    ]);
                                } catch (\Throwable $e) {
                                    // ignore
                                }
                            }
                        }

                        // Update watchlist last-checked and last-seen.
                        if ($newMaxIso) {
                            $stUpdate->execute([
                                ':t' => $now,
                                ':s' => $newMaxIso,
                                ':u' => $newMaxUri,
                                ':o' => $ownerDid,
                                ':d' => $watchedDid,
                            ]);
                        } else {
                            $stUpdateChecked->execute([
                                ':t' => $now,
                                ':o' => $ownerDid,
                                ':d' => $watchedDid,
                            ]);
                        }

                        $newItems = array_reverse($newItemsDesc);

                        $out[] = [
                            'watchedDid' => $watchedDid,
                            'watchedHandle' => $w['watched_handle'] ?? null,
                            'ok' => true,
                            'sync' => $sync,
                            'newCount' => count($newUris),
                            'newPosts' => $newItems,
                            'lastSeenPostCreatedAt' => $newMaxIso,
                            'lastSeenPostUri' => $newMaxUri,
                            'checkedAt' => $now,
                            'initialized' => ($lastSeenTs === null),
                        ];
                    }

                    return $this->json([
                        'ok' => true,
                        'ownerDid' => $ownerDid,
                        'checkedAt' => $now,
                        'hours' => $hours,
                        'results' => $out,
                    ]);
                }

                case 'cacheCalendarMonth': {
                    // Return month coverage (days with cached posts/notifications) for calendar rendering.
                    // Params:
                    // - month: "YYYY-MM" (required)
                    // - kind: "posts" | "notifications" | "both" (default both)

                    $month = (string)($params['month'] ?? '');
                    $kind = (string)($params['kind'] ?? 'both');

                    if (!preg_match('/^\d{4}-\d{2}$/', $month)) {
                        return $this->json(['ok' => false, 'error' => 'Invalid month. Expected YYYY-MM'], 400);
                    }

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['ok' => false, 'error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $tz = new \DateTimeZone('UTC');
                    $start = new \DateTimeImmutable($month . '-01 00:00:00', $tz);
                    $end = $start->modify('+1 month');

                    $startIso = $start->format('c');
                    $endIso = $end->format('c');

                    $out = [
                        'ok' => true,
                        'actorDid' => $meDid,
                        'month' => $month,
                        'startIso' => $startIso,
                        'endIso' => $endIso,
                        'posts' => ['days' => [], 'counts' => new \stdClass(), 'updatedAt' => new \stdClass()],
                        'notifications' => ['days' => [], 'counts' => new \stdClass(), 'updatedAt' => new \stdClass()],
                        'range' => [
                            'posts' => ['min' => null, 'max' => null],
                            'notifications' => ['min' => null, 'max' => null],
                        ],
                    ];

                    // Global ranges (useful for UI).
                    try {
                        $st = $pdo->prepare('SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM posts WHERE actor_did = :a');
                        $st->execute([':a' => $meDid]);
                        $row = $st->fetch(\PDO::FETCH_ASSOC) ?: [];
                        $out['range']['posts']['min'] = $row['mn'] ?? null;
                        $out['range']['posts']['max'] = $row['mx'] ?? null;
                    } catch (\Throwable $e) {
                        // ignore
                    }
                    try {
                        $st = $pdo->prepare('SELECT MIN(indexed_at) AS mn, MAX(indexed_at) AS mx FROM notifications WHERE actor_did = :a');
                        $st->execute([':a' => $meDid]);
                        $row = $st->fetch(\PDO::FETCH_ASSOC) ?: [];
                        $out['range']['notifications']['min'] = $row['mn'] ?? null;
                        $out['range']['notifications']['max'] = $row['mx'] ?? null;
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    if ($kind === 'posts' || $kind === 'both') {
                        $days = [];
                        $counts = [];
                        $updatedAt = [];
                        $st = $pdo->prepare('SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS c, MAX(updated_at) AS u
                            FROM posts
                            WHERE actor_did = :a AND created_at >= :s AND created_at < :e
                            GROUP BY day');
                        $st->execute([':a' => $meDid, ':s' => $startIso, ':e' => $endIso]);
                        $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                        foreach ($rows as $r) {
                            $day = (string)($r['day'] ?? '');
                            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) continue;
                            $d = (int)substr($day, 8, 2);
                            if ($d < 1 || $d > 31) continue;
                            $days[] = $d;
                            $counts[$day] = (int)($r['c'] ?? 0);
                            if (!empty($r['u'])) $updatedAt[$day] = (string)$r['u'];
                        }
                        $out['posts']['days'] = array_values(array_unique($days));
                        sort($out['posts']['days']);
                        $out['posts']['counts'] = (object)$counts;
                        $out['posts']['updatedAt'] = (object)$updatedAt;
                    }

                    if ($kind === 'notifications' || $kind === 'both') {
                        $days = [];
                        $counts = [];
                        $updatedAt = [];
                        $st = $pdo->prepare('SELECT SUBSTR(indexed_at, 1, 10) AS day, COUNT(*) AS c, MAX(updated_at) AS u
                            FROM notifications
                            WHERE actor_did = :a AND indexed_at IS NOT NULL AND indexed_at >= :s AND indexed_at < :e
                            GROUP BY day');
                        $st->execute([':a' => $meDid, ':s' => $startIso, ':e' => $endIso]);
                        $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                        foreach ($rows as $r) {
                            $day = (string)($r['day'] ?? '');
                            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) continue;
                            $d = (int)substr($day, 8, 2);
                            if ($d < 1 || $d > 31) continue;
                            $days[] = $d;
                            $counts[$day] = (int)($r['c'] ?? 0);
                            if (!empty($r['u'])) $updatedAt[$day] = (string)$r['u'];
                        }
                        $out['notifications']['days'] = array_values(array_unique($days));
                        sort($out['notifications']['days']);
                        $out['notifications']['counts'] = (object)$counts;
                        $out['notifications']['updatedAt'] = (object)$updatedAt;
                    }

                    return $this->json($out);
                }

                case 'cacheCatalogStatus': {
                    // Return high-level stats about the cached catalogue for the currently connected account.
                    // Useful for management UI (prune/resync).

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $dbPath = $this->cacheDbPath();
                    $dbDir = $this->cacheDir();

                    $pageCount = null;
                    $pageSize = null;
                    $pragmaBytes = null;
                    try {
                        $pageCount = (int)$pdo->query('PRAGMA page_count')->fetchColumn();
                        $pageSize = (int)$pdo->query('PRAGMA page_size')->fetchColumn();
                        if ($pageCount > 0 && $pageSize > 0) {
                            $pragmaBytes = $pageCount * $pageSize;
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    $fileBytes = null;
                    $walBytes = null;
                    $shmBytes = null;
                    try {
                        if (is_file($dbPath)) $fileBytes = @filesize($dbPath);
                        if (is_file($dbPath . '-wal')) $walBytes = @filesize($dbPath . '-wal');
                        if (is_file($dbPath . '-shm')) $shmBytes = @filesize($dbPath . '-shm');
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    $posts = ['count' => 0, 'minCreatedAt' => null, 'maxCreatedAt' => null];
                    $notifs = ['count' => 0, 'minIndexedAt' => null, 'maxIndexedAt' => null];

                    try {
                        $st = $pdo->prepare('SELECT COUNT(1) AS c, MIN(created_at) AS mn, MAX(created_at) AS mx FROM posts WHERE actor_did = :a');
                        $st->execute([':a' => $meDid]);
                        $r = $st->fetch(\PDO::FETCH_ASSOC) ?: [];
                        $posts['count'] = (int)($r['c'] ?? 0);
                        $posts['minCreatedAt'] = $r['mn'] ?? null;
                        $posts['maxCreatedAt'] = $r['mx'] ?? null;
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    try {
                        $st = $pdo->prepare('SELECT COUNT(1) AS c, MIN(indexed_at) AS mn, MAX(indexed_at) AS mx FROM notifications WHERE actor_did = :a');
                        $st->execute([':a' => $meDid]);
                        $r = $st->fetch(\PDO::FETCH_ASSOC) ?: [];
                        $notifs['count'] = (int)($r['c'] ?? 0);
                        $notifs['minIndexedAt'] = $r['mn'] ?? null;
                        $notifs['maxIndexedAt'] = $r['mx'] ?? null;
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    $metaKeys = [
                        'posts_backfill_cursor',
                        'posts_backfill_done',
                        'posts_backfill_filter',
                        'posts_backfill_last_stop_before',
                        'notifications_backfill_cursor',
                        'notifications_backfill_last_stop_before',
                        'notifications_backfill_last_cutoff_iso',
                        'notifications_backfill_last_oldest_seen_iso',
                        'notifications_backfill_last_retention_limited',
                        'notifications_backfill_last_done',
                    ];
                    $meta = [];
                    foreach ($metaKeys as $k) {
                        try {
                            $meta[$k] = $this->cacheMetaGet($pdo, $meDid, $k);
                        } catch (\Throwable $e) {
                            $meta[$k] = null;
                        }
                    }

                    return $this->json([
                        'ok' => true,
                        'actorDid' => $meDid,
                        'db' => [
                            'dir' => $dbDir,
                            'path' => $dbPath,
                            'fileBytes' => $fileBytes,
                            'walBytes' => $walBytes,
                            'shmBytes' => $shmBytes,
                            'pageCount' => $pageCount,
                            'pageSize' => $pageSize,
                            'pragmaBytes' => $pragmaBytes,
                        ],
                        'posts' => $posts,
                        'notifications' => $notifs,
                        'meta' => $meta,
                    ]);
                }

                case 'cacheCatalogPrune': {
                    // Prune cached catalogue data for the currently connected account.
                    // Params:
                    // - kind: 'posts' | 'notifications' | 'all' (default posts)
                    // - before: ISO timestamp cutoff (exclusive). Rows older than this will be deleted.
                    // - keepDays: alternative to before (keep last N days)
                    // - vacuum: true|false (default false)

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $kind = (string)($params['kind'] ?? 'posts');
                    $before = isset($params['before']) ? trim((string)$params['before']) : '';
                    $keepDays = isset($params['keepDays']) ? (int)$params['keepDays'] : null;
                    $vacuum = !empty($params['vacuum']);

                    if ($before === '' && ($keepDays === null || $keepDays <= 0)) {
                        return $this->json(['error' => 'Missing before or keepDays'], 400);
                    }

                    $cutoffIso = null;
                    if ($before !== '') {
                        $t = strtotime($before);
                        if ($t === false) return $this->json(['error' => 'Invalid before timestamp'], 400);
                        $cutoffIso = gmdate('c', $t);
                    } else {
                        $days = max(1, min(3650, (int)$keepDays));
                        $cutoffIso = gmdate('c', time() - ($days * 86400));
                    }

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $deleted = [
                        'posts' => 0,
                        'notifications' => 0,
                    ];

                    $pdo->beginTransaction();
                    try {
                        if ($kind === 'posts' || $kind === 'all') {
                            $st = $pdo->prepare('DELETE FROM posts WHERE actor_did = :a AND created_at IS NOT NULL AND created_at < :c');
                            $st->execute([':a' => $meDid, ':c' => $cutoffIso]);
                            $deleted['posts'] = (int)$st->rowCount();
                        }

                        if ($kind === 'notifications' || $kind === 'all') {
                            $st = $pdo->prepare('DELETE FROM notifications WHERE actor_did = :a AND indexed_at IS NOT NULL AND indexed_at < :c');
                            $st->execute([':a' => $meDid, ':c' => $cutoffIso]);
                            $deleted['notifications'] = (int)$st->rowCount();
                        }

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        try { $pdo->rollBack(); } catch (\Throwable $e2) {}
                        throw $e;
                    }

                    if ($vacuum) {
                        // Vacuum can be expensive; keep it opt-in.
                        try { $pdo->exec('VACUUM'); } catch (\Throwable $e) { /* ignore */ }
                    }

                    return $this->json([
                        'ok' => true,
                        'actorDid' => $meDid,
                        'kind' => $kind,
                        'cutoffIso' => $cutoffIso,
                        'deleted' => $deleted,
                    ]);
                }

                case 'cacheCatalogResync': {
                    // Reset backfill state (and optionally clear cached rows) so the catalogue can be re-ingested.
                    // Params:
                    // - kind: 'posts' | 'notifications' | 'all' (default posts)
                    // - clear: true|false (default true)
                    // - postsFilter: optional app.bsky.feed.getAuthorFeed filter (e.g. 'posts_with_replies')

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $kind = (string)($params['kind'] ?? 'posts');
                    $clear = !array_key_exists('clear', (array)$params) ? true : (bool)$params['clear'];
                    $postsFilter = isset($params['postsFilter']) ? trim((string)$params['postsFilter']) : '';

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $pdo->beginTransaction();
                    try {
                        if ($clear) {
                            if ($kind === 'posts' || $kind === 'all') {
                                $st = $pdo->prepare('DELETE FROM posts WHERE actor_did = :a');
                                $st->execute([':a' => $meDid]);
                            }
                            if ($kind === 'notifications' || $kind === 'all') {
                                $st = $pdo->prepare('DELETE FROM notifications WHERE actor_did = :a');
                                $st->execute([':a' => $meDid]);
                            }
                        }

                        if ($kind === 'posts' || $kind === 'all') {
                            $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_cursor', '');
                            $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_done', '');
                            $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_last_stop_before', '');
                            if ($postsFilter !== '') {
                                $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_filter', $postsFilter);
                            }
                        }

                        if ($kind === 'notifications' || $kind === 'all') {
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_cursor', '');
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_stop_before', '');
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_cutoff_iso', '');
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_oldest_seen_iso', '');
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_retention_limited', '');
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_done', '');
                        }

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        try { $pdo->rollBack(); } catch (\Throwable $e2) {}
                        throw $e;
                    }

                    return $this->json([
                        'ok' => true,
                        'actorDid' => $meDid,
                        'kind' => $kind,
                        'cleared' => $clear,
                        'postsFilter' => $postsFilter !== '' ? $postsFilter : null,
                    ]);
                }

                case 'cacheQueryPeople': {
                    // Query cached followers/following.
                    // Params:
                    // - list: 'followers' | 'following' | 'all'
                    // - q: query string (supports emoji via LIKE fallback)
                    // - sort: 'followers'|'following'|'posts'|'name'|'handle'|'age'
                    // - mutual: true|false (only mutuals)
                    // - limit/offset

                    $list = (string)($params['list'] ?? 'followers');
                    $q = (string)($params['q'] ?? '');
                    $sort = (string)($params['sort'] ?? 'followers');
                    $mutual = (bool)($params['mutual'] ?? false);
                    $limit = min(200, max(1, (int)($params['limit'] ?? 100)));
                    $offset = max(0, (int)($params['offset'] ?? 0));

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $res = $this->cacheQueryPeople($pdo, $meDid, $list, $q, $sort, $mutual, $limit, $offset);
                    return $this->json($res);
                }

                case 'cacheFriendDiff': {
                    // Return added/removed between last 2 snapshots.
                    $kind = (string)($params['kind'] ?? 'followers');
                    $limit = min(500, max(0, (int)($params['limit'] ?? 200)));

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $diff = $this->cacheDiffLatestTwo($pdo, $meDid, $kind, $limit, true);
                    return $this->json($diff);
                }

                case 'cacheQueryNotifications': {
                    // Query cached notifications.
                    // Params:
                    // - since: optional ISO timestamp (inclusive)
                    // - until: optional ISO timestamp (inclusive)
                    // - hours: if >0 and since is not provided, use now-hours as cutoff
                    // - reasons[] (optional), limit/offset, newestFirst (default true)
                    $hours = min(24 * 365 * 30, max(0, (int)($params['hours'] ?? 720)));
                    $since = isset($params['since']) ? (string)$params['since'] : null;
                    $until = isset($params['until']) ? (string)$params['until'] : null;
                    $reasons = (isset($params['reasons']) && is_array($params['reasons'])) ? array_values(array_unique(array_map('strval', $params['reasons']))) : [];
                    $limit = min(200, max(1, (int)($params['limit'] ?? 100)));
                    $offset = max(0, (int)($params['offset'] ?? 0));
                    $newestFirst = ($params['newestFirst'] ?? true) ? true : false;

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $out = $this->cacheQueryNotifications($pdo, $meDid, $since, $until, $hours, $reasons, $limit, $offset, $newestFirst);
                    return $this->json($out);
                }

                case 'cacheBackfillNotifications': {
                    // Backfill older notifications into SQLite without syncing followers/following.
                    // This resumes via notifications_backfill_cursor.
                    // Params:
                    // - hours: window size used to compute a cutoff (default 30d)
                    // - stopBefore: optional ISO timestamp; if provided, we will backfill until we reach it (even if older than hours)
                    $hours = min(24 * 365 * 30, max(1, (int)($params['hours'] ?? 24 * 30)));
                    $pagesMax = min(200, max(1, (int)($params['pagesMax'] ?? 30)));
                    $reset = !empty($params['reset']);
                    $stopBefore = isset($params['stopBefore']) ? (string)$params['stopBefore'] : null;

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $pdo->beginTransaction();
                    try {
                        $now = gmdate('c');

                        if ($reset) {
                            // Clear backfill cursor so the next sync starts from newest and paginates backward again.
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_cursor', '');
                        }

                        $res = $this->cacheSyncNotifications($pdo, $session, $meDid, $hours, $pagesMax, $stopBefore);

                        // Best-effort: persist some backfill context for status/UI.
                        try {
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_hours', (string)$hours);
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_stop_before', (string)($stopBefore ?: ''));
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_cutoff_iso', (string)($res['cutoffIso'] ?? ''));
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_oldest_seen_iso', (string)($res['oldestSeenIso'] ?? ''));
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_retention_limited', !empty($res['retentionLimited']) ? '1' : '');
                            $this->cacheMetaSet($pdo, $meDid, 'notifications_backfill_last_done', !empty($res['done']) ? '1' : '');
                        } catch (\Throwable $e) {
                            // ignore
                        }

                        $this->cacheMetaSet($pdo, $meDid, 'last_notifications_sync_at', $now);
                        $cursor = $this->cacheMetaGet($pdo, $meDid, 'notifications_backfill_cursor');
                        $pdo->commit();
                        return $this->json(['ok' => true, 'actorDid' => $meDid, 'syncedAt' => $now, 'hours' => $hours, 'pagesMax' => $pagesMax, 'stopBefore' => $stopBefore, 'cursor' => $cursor, 'result' => $res]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'cacheBackfillMyPosts': {
                    // Backfill older "My Posts" into SQLite. Resumes via posts_backfill_cursor.
                    // Params:
                    // - pagesMax: number of pages per request (default 10)
                    // - filter: optional author feed filter
                    // - reset: clear cursor/done and start from newest again
                    // - stopBefore: optional ISO timestamp; stop paging once we pass it
                    $pagesMax = min(200, max(1, (int)($params['pagesMax'] ?? 10)));
                    $filter = isset($params['filter']) ? (string)$params['filter'] : null;
                    $reset = !empty($params['reset']);
                    $stopBefore = isset($params['stopBefore']) ? (string)$params['stopBefore'] : null;

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $pdo->beginTransaction();
                    try {
                        $now = gmdate('c');
                        $res = $this->cacheBackfillMyPosts($pdo, $session, $meDid, $pagesMax, $filter, $reset, $stopBefore);

                        // Best-effort: keep last target cutoff for UI/status.
                        try {
                            $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_last_stop_before', (string)($stopBefore ?: ''));
                        } catch (\Throwable $e) {
                            // ignore
                        }

                        $this->cacheMetaSet($pdo, $meDid, 'last_posts_sync_at', $now);
                        $pdo->commit();
                        return $this->json(['ok' => true, 'syncedAt' => $now] + $res);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'cacheSyncRecent': {
                    // Lightweight periodic sync for the currently connected user.
                    // Intended to run every ~minute while the SPA is open.
                    $minutes = min(60, max(1, (int)($params['minutes'] ?? 2)));
                    $pagesMax = min(20, max(1, (int)($params['pagesMax'] ?? 5)));

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $pdo->beginTransaction();
                    try {
                        $now = gmdate('c');

                        // Notifications: fetch a small recent window; upserts keep this cheap.
                        $notif = $this->cacheSyncNotifications($pdo, $session, $meDid, 24, $pagesMax);
                        $this->cacheMetaSet($pdo, $meDid, 'last_notifications_sync_at', $now);

                        // Posts: sync newest pages and stop when we hit already-seen timestamps.
                        $posts = $this->cacheSyncMyPosts($pdo, $session, $meDid, 24, $pagesMax, null);
                        $this->cacheMetaSet($pdo, $meDid, 'last_posts_sync_at', $now);

                        // Auto-backfill older posts incrementally (resumes via posts_backfill_cursor).
                        // Small-per-tick to avoid timeouts and rate limit spikes.
                        $postsBackfill = null;
                        try {
                            if ($this->envBool('CONCRETESKY_AUTO_BACKFILL_POSTS', true)) {
                                $done = $this->cacheMetaGet($pdo, $meDid, 'posts_backfill_done');
                                if ($done !== '1') {
                                    $bfPages = (int)(getenv('CONCRETESKY_AUTO_BACKFILL_POSTS_PAGES_PER_SYNC') ?: 1);
                                    if ($bfPages < 1) $bfPages = 1;
                                    if ($bfPages > 10) $bfPages = 10;

                                    // Default to include replies as well as posts.
                                    $filterEnv = getenv('CONCRETESKY_AUTO_BACKFILL_POSTS_FILTER');
                                    $filter = ($filterEnv !== false && $filterEnv !== null) ? trim((string)$filterEnv) : '';
                                    if ($filter === '' || $filter === 'all') {
                                        $filter = 'posts_with_replies';
                                    }

                                    // If the desired filter changes, reset cursor/done for this DID.
                                    $prevFilter = $this->cacheMetaGet($pdo, $meDid, 'posts_backfill_filter');
                                    if ($prevFilter !== $filter) {
                                        $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_cursor', '');
                                        $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_done', '');
                                        $this->cacheMetaSet($pdo, $meDid, 'posts_backfill_filter', $filter);
                                    }

                                    // If the server rejects the filter for any reason, fall back to default behavior.
                                    try {
                                        $postsBackfill = $this->cacheBackfillMyPosts($pdo, $session, $meDid, $bfPages, $filter, false, null);
                                    } catch (\Throwable $e2) {
                                        $postsBackfill = $this->cacheBackfillMyPosts($pdo, $session, $meDid, $bfPages, null, false, null);
                                    }
                                }
                            }
                        } catch (\Throwable $e) {
                            // ignore
                        }

                        $pdo->commit();
                        return $this->json(['ok' => true, 'actorDid' => $meDid, 'syncedAt' => $now, 'minutes' => $minutes, 'notifications' => $notif, 'posts' => $posts, 'postsBackfill' => $postsBackfill]);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'cacheSyncMyPosts': {
                    $hours = min(24 * 365 * 30, max(1, (int)($params['hours'] ?? 24 * 30)));
                    $pagesMax = min(200, max(1, (int)($params['pagesMax'] ?? 25)));
                    $filter = isset($params['filter']) ? (string)$params['filter'] : null;

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $pdo->beginTransaction();
                    try {
                        $res = $this->cacheSyncMyPosts($pdo, $session, $meDid, $hours, $pagesMax, $filter);
                        $this->cacheMetaSet($pdo, $meDid, 'last_posts_sync_at', gmdate('c'));
                        $pdo->commit();
                        return $this->json(['ok' => true] + $res);
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }
                }

                case 'cacheQueryMyPosts': {
                    // Query cached posts.
                    // Params:
                    // - since: optional ISO timestamp (inclusive)
                    // - until: optional ISO timestamp (inclusive)
                    // - hours: if >0 and since is not provided, use now-hours as cutoff; if 0, no cutoff
                    $hours = min(24 * 365 * 50, max(0, (int)($params['hours'] ?? 24)));
                    $since = isset($params['since']) ? (string)$params['since'] : null;
                    $until = isset($params['until']) ? (string)$params['until'] : null;
                    $types = (isset($params['types']) && is_array($params['types'])) ? array_values(array_unique(array_map('strval', $params['types']))) : [];
                    $limit = min(200, max(1, (int)($params['limit'] ?? 100)));
                    $offset = max(0, (int)($params['offset'] ?? 0));
                    $newestFirst = ($params['newestFirst'] ?? true) ? true : false;

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $out = $this->cacheQueryMyPosts($pdo, $meDid, $since, $until, $hours, $types, $limit, $offset, $newestFirst);
                    return $this->json($out);
                }

                case 'trending': {
                    // Trending view parity.
                    // If a network trending endpoint is available, use it; otherwise approximate via cached aggregation.
                    // Params:
                    // - mode: 'network' | 'cache' (default 'cache')
                    // - hours: cache window (default 168)
                    // - limit: max items per section (default 20)
                    // - maxPosts: max cached posts to scan (default 2000)

                    $mode = (string)($params['mode'] ?? 'cache');
                    if ($mode !== 'network') $mode = 'cache';

                    $hours = min(24 * 365 * 5, max(1, (int)($params['hours'] ?? (24 * 7))));
                    $limit = min(50, max(1, (int)($params['limit'] ?? 20)));
                    $maxPosts = min(5000, max(100, (int)($params['maxPosts'] ?? 2000)));

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    // Try network endpoint if requested.
                    if ($mode === 'network') {
                        try {
                            // Not all PDS/appviews expose these; treat as optional.
                            // If this fails, we fall back to cache aggregation.
                            $res = $this->xrpcSession('GET', 'app.bsky.unspecced.getTrendingTopics', $session, ['limit' => $limit]);
                            $topics = (isset($res['topics']) && is_array($res['topics'])) ? $res['topics'] : [];

                            $hashtags = [];
                            foreach ($topics as $t) {
                                $tag = trim((string)($t['topic'] ?? $t['tag'] ?? $t['name'] ?? ''));
                                if ($tag === '') continue;
                                if ($tag[0] !== '#') $tag = '#' . $tag;
                                $count = (int)($t['count'] ?? $t['postsCount'] ?? 0);
                                $hashtags[] = ['tag' => $tag, 'count' => $count];
                            }

                            return $this->json([
                                'ok' => true,
                                'mode' => 'network',
                                'source' => 'network',
                                'actorDid' => $meDid,
                                'windowHours' => null,
                                'limit' => $limit,
                                'hashtags' => array_slice($hashtags, 0, $limit),
                                'links' => [],
                            ]);
                        } catch (\Throwable $e) {
                            // fall through
                        }
                    }

                    // Cache aggregation fallback.
                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $cutoffIso = gmdate('c', time() - ($hours * 3600));

                    $st = $pdo->prepare('SELECT text, raw_json FROM posts WHERE actor_did = :a AND created_at IS NOT NULL AND created_at >= :cut ORDER BY created_at DESC LIMIT :lim');
                    $st->bindValue(':a', $meDid, \PDO::PARAM_STR);
                    $st->bindValue(':cut', $cutoffIso, \PDO::PARAM_STR);
                    $st->bindValue(':lim', $maxPosts, \PDO::PARAM_INT);
                    $st->execute();
                    $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                    $tagCounts = [];
                    $hostCounts = [];
                    $hostSamples = [];

                    $extractHosts = static function (string $text): array {
                        $out = [];
                        if ($text === '') return $out;
                        if (preg_match_all('~https?://[^\s<>()"\\\\]+~i', $text, $m)) {
                            foreach ($m[0] as $u) {
                                $u = trim((string)$u);
                                if ($u === '') continue;
                                $out[] = $u;
                            }
                        }
                        return $out;
                    };

                    $extractTags = static function (string $text): array {
                        $out = [];
                        if ($text === '') return $out;
                        // Best-effort hashtag matcher; count Unicode letters/digits/marks/_.
                        if (preg_match_all('/(^|[^\p{L}\p{M}\p{Nd}_])#([\p{L}\p{M}\p{Nd}_]{2,80})/u', $text, $m)) {
                            foreach ($m[2] as $tag) {
                                $tag = strtolower((string)$tag);
                                if ($tag === '') continue;
                                $out[] = $tag;
                            }
                        }
                        return $out;
                    };

                    foreach ($rows as $r) {
                        $text = trim((string)($r['text'] ?? ''));
                        $raw = null;
                        if ($text === '' || !empty($r['raw_json'])) {
                            $raw = !empty($r['raw_json']) ? json_decode((string)$r['raw_json'], true) : null;
                        }

                        // Prefer cached posts.text; fall back to decoded record text.
                        if ($text === '' && $raw) {
                            $rec = $raw['post']['record'] ?? $raw['record'] ?? null;
                            if (is_array($rec) && isset($rec['text'])) $text = trim((string)$rec['text']);
                        }

                        $postTags = array_values(array_unique($extractTags($text)));
                        foreach ($postTags as $t) {
                            $tagCounts[$t] = ($tagCounts[$t] ?? 0) + 1;
                        }

                        $urls = $extractHosts($text);

                        // Also collect facet/embeds URLs when available.
                        if ($raw) {
                            try {
                                $rec = $raw['post']['record'] ?? $raw['record'] ?? [];
                                $facets = (isset($rec['facets']) && is_array($rec['facets'])) ? $rec['facets'] : [];
                                foreach ($facets as $facet) {
                                    $features = (isset($facet['features']) && is_array($facet['features'])) ? $facet['features'] : [];
                                    foreach ($features as $feat) {
                                        $u = (string)($feat['uri'] ?? '');
                                        if ($u !== '' && (stripos($u, 'http://') === 0 || stripos($u, 'https://') === 0)) $urls[] = $u;
                                    }
                                }

                                $embed = $raw['post']['embed'] ?? $rec['embed'] ?? null;
                                if (is_array($embed)) {
                                    $u = (string)($embed['external']['uri'] ?? '');
                                    if ($u !== '' && (stripos($u, 'http://') === 0 || stripos($u, 'https://') === 0)) $urls[] = $u;
                                }
                            } catch (\Throwable $e) {
                                // ignore
                            }
                        }

                        $urls = array_values(array_unique(array_filter(array_map('strval', $urls))));
                        foreach ($urls as $u) {
                            $host = '';
                            try {
                                $parts = @parse_url($u);
                                $host = isset($parts['host']) ? strtolower((string)$parts['host']) : '';
                            } catch (\Throwable $e) {
                                $host = '';
                            }
                            $host = preg_replace('/^www\./i', '', (string)$host);
                            if (!$host) continue;
                            $hostCounts[$host] = ($hostCounts[$host] ?? 0) + 1;
                            if (!isset($hostSamples[$host])) $hostSamples[$host] = $u;
                        }
                    }

                    arsort($tagCounts);
                    arsort($hostCounts);

                    $hashtags = [];
                    foreach ($tagCounts as $t => $c) {
                        $hashtags[] = ['tag' => '#' . $t, 'count' => (int)$c];
                        if (count($hashtags) >= $limit) break;
                    }

                    $links = [];
                    foreach ($hostCounts as $h => $c) {
                        $links[] = ['host' => $h, 'count' => (int)$c, 'sampleUrl' => $hostSamples[$h] ?? null];
                        if (count($links) >= $limit) break;
                    }

                    return $this->json([
                        'ok' => true,
                        'mode' => 'cache',
                        'source' => 'cache',
                        'actorDid' => $meDid,
                        'windowHours' => $hours,
                        'cutoff' => $cutoffIso,
                        'limit' => $limit,
                        'maxPosts' => $maxPosts,
                        'scannedPosts' => count($rows),
                        'hashtags' => $hashtags,
                        'links' => $links,
                    ]);
                }

                case 'cacheDbInspect': {
                    // Admin-only DB inspector.
                    $this->requireSuperUser($jwt);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $path = $this->cacheDbPath();
                    $dir = $this->cacheDir();
                    $exists = is_file($path);
                    $size = $exists ? @filesize($path) : null;
                    $size = ($size !== false) ? $size : null;

                    $sqliteVersion = null;
                    try { $sqliteVersion = $pdo->query('SELECT sqlite_version()')->fetchColumn() ?: null; } catch (\Throwable $e) { /* ignore */ }

                    $pragma = static function (\PDO $pdo, string $key) {
                        try {
                            $v = $pdo->query('PRAGMA ' . $key)->fetchColumn();
                            return $v !== false ? $v : null;
                        } catch (\Throwable $e) {
                            return null;
                        }
                    };

                    $dbstatAvailable = false;
                    try {
                        $pdo->query('SELECT name FROM dbstat LIMIT 1')->fetchColumn();
                        $dbstatAvailable = true;
                    } catch (\Throwable $e) {
                        $dbstatAvailable = false;
                    }

                    $stDbstat = null;
                    if ($dbstatAvailable) {
                        try {
                            $stDbstat = $pdo->prepare('SELECT SUM(pgsize) FROM dbstat WHERE name = :n');
                        } catch (\Throwable $e) {
                            $stDbstat = null;
                            $dbstatAvailable = false;
                        }
                    }

                    $timeCandidates = ['indexed_at', 'created_at', 'synced_at', 'updated_at', 'seen_at', 'at', 'ts'];
                    $tablesTotalBytesApprox = 0;

                    $tables = [];
                    try {
                        $names = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")->fetchAll(\PDO::FETCH_COLUMN) ?: [];
                        foreach ($names as $name) {
                            $n = (string)$name;
                            if ($n === '') continue;
                            $q = '"' . str_replace('"', '""', $n) . '"';

                            $cnt = null;
                            try {
                                $cnt = (int)$pdo->query('SELECT COUNT(*) FROM ' . $q)->fetchColumn();
                            } catch (\Throwable $e) {
                                $cnt = null;
                            }

                            $approxBytes = null;
                            if ($dbstatAvailable && $stDbstat) {
                                try {
                                    $stDbstat->execute([':n' => $n]);
                                    $v = $stDbstat->fetchColumn();
                                    $approxBytes = ($v !== false && $v !== null) ? (int)$v : null;
                                    if ($approxBytes !== null) $tablesTotalBytesApprox += max(0, $approxBytes);
                                } catch (\Throwable $e) {
                                    $approxBytes = null;
                                }
                            }

                            // Best-effort oldest/newest timestamps based on a detected time column.
                            $timeCol = null;
                            $oldest = null;
                            $newest = null;
                            try {
                                $cols = $pdo->query('PRAGMA table_info(' . $q . ')')->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                                $have = [];
                                foreach ($cols as $c) {
                                    $cn = (string)($c['name'] ?? '');
                                    if ($cn === '') continue;
                                    $have[strtolower($cn)] = $cn;
                                }
                                foreach ($timeCandidates as $cand) {
                                    if (isset($have[$cand])) { $timeCol = $have[$cand]; break; }
                                }
                            } catch (\Throwable $e) {
                                $timeCol = null;
                            }

                            if ($timeCol) {
                                $qt = '"' . str_replace('"', '""', $timeCol) . '"';
                                try {
                                    $row = $pdo->query('SELECT MIN(' . $qt . '), MAX(' . $qt . ') FROM ' . $q . ' WHERE ' . $qt . ' IS NOT NULL AND ' . $qt . " != ''")->fetch(\PDO::FETCH_NUM) ?: null;
                                    if ($row) {
                                        $oldest = $row[0] !== null ? (string)$row[0] : null;
                                        $newest = $row[1] !== null ? (string)$row[1] : null;
                                    }
                                } catch (\Throwable $e) {
                                    $oldest = null;
                                    $newest = null;
                                }
                            }

                            $tables[] = [
                                'name' => $n,
                                'rows' => $cnt,
                                'approxBytes' => $approxBytes,
                                'timeColumn' => $timeCol,
                                'oldest' => $oldest,
                                'newest' => $newest,
                            ];
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    $indexes = [];
                    try {
                        $rows = $pdo->query("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                        foreach ($rows as $r) {
                            $indexes[] = ['name' => $r['name'] ?? null, 'table' => $r['tbl_name'] ?? null];
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    // FTS5 availability + whether our posts_fts index exists and is queryable.
                    $fts5Enabled = null;
                    try {
                        $v = $pdo->query("SELECT sqlite_compileoption_used('ENABLE_FTS5')")->fetchColumn();
                        if ($v !== false) $fts5Enabled = ((int)$v) === 1;
                    } catch (\Throwable $e) {
                        $fts5Enabled = null;
                    }

                    $postsFtsExists = null;
                    try {
                        $v = $pdo->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='posts_fts' LIMIT 1")->fetchColumn();
                        $postsFtsExists = $v !== false;
                    } catch (\Throwable $e) {
                        $postsFtsExists = null;
                    }

                    $postsFtsOperational = null;
                    if ($postsFtsExists) {
                        try {
                            // Smoke query: just ensure the virtual table can be read.
                            $pdo->query("SELECT rowid FROM posts_fts LIMIT 1")->fetchColumn();
                            $postsFtsOperational = true;
                        } catch (\Throwable $e) {
                            $postsFtsOperational = false;
                        }
                    }

                    return $this->json([
                        'ok' => true,
                        'path' => $path,
                        'dir' => $dir,
                        'exists' => $exists,
                        'writableDir' => is_writable($dir),
                        'writableDb' => $exists ? is_writable($path) : null,
                        'sizeBytes' => $size,
                        'sqliteVersion' => $sqliteVersion,
                        'journalMode' => $pragma($pdo, 'journal_mode'),
                        'pageSize' => $pragma($pdo, 'page_size'),
                        'pageCount' => $pragma($pdo, 'page_count'),
                        'freelistCount' => $pragma($pdo, 'freelist_count'),
                        'cacheSchemaVersion' => $this->cacheMetaGet($pdo, null, 'schema_version'),
                        'cacheSchemaExpected' => self::CACHE_SCHEMA_VERSION,
                        'lastVacuumAt' => $this->cacheMetaGet($pdo, null, 'last_vacuum_at'),
                        'dbstatAvailable' => $dbstatAvailable,
                        'tablesTotalBytesApprox' => $dbstatAvailable ? $tablesTotalBytesApprox : null,
                        'tables' => $tables,
                        'indexes' => $indexes,
                        'fts' => [
                            'fts5Enabled' => $fts5Enabled,
                            'postsFtsExists' => $postsFtsExists,
                            'postsFtsOperational' => $postsFtsOperational,
                        ],
                    ]);
                }

                case 'cacheVacuum': {
                    // Admin-only vacuum/checkpoint.
                    $this->requireSuperUser($jwt);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    // WAL checkpoint first to reduce WAL growth.
                    try { $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (\Throwable $e) { /* ignore */ }
                    $pdo->exec('VACUUM;');
                    try { $pdo->exec('ANALYZE;'); } catch (\Throwable $e) { /* ignore */ }

                    $now = gmdate('c');
                    $this->cacheMetaSet($pdo, null, 'last_vacuum_at', $now);
                    return $this->json(['ok' => true, 'vacuumedAt' => $now]);
                }

                case 'cachePrune': {
                    // Admin-only pruning for the active account.
                    $this->requireSuperUser($jwt);

                    $keepDaysPosts = min(3650, max(1, (int)($params['keepDaysPosts'] ?? 365)));
                    $keepDaysNotifs = min(3650, max(1, (int)($params['keepDaysNotifs'] ?? 365)));

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    $cutPosts = gmdate('c', time() - ($keepDaysPosts * 86400));
                    $cutNotifs = gmdate('c', time() - ($keepDaysNotifs * 86400));

                    $deletedPosts = 0;
                    $deletedNotifs = 0;
                    $deletedOauth = 0;

                    $pdo->beginTransaction();
                    try {
                        $st = $pdo->prepare('DELETE FROM posts WHERE actor_did = :a AND created_at IS NOT NULL AND created_at < :cut');
                        $st->execute([':a' => $meDid, ':cut' => $cutPosts]);
                        $deletedPosts = (int)$st->rowCount();

                        $st2 = $pdo->prepare('DELETE FROM notifications WHERE actor_did = :a AND indexed_at IS NOT NULL AND indexed_at < :cut');
                        $st2->execute([':a' => $meDid, ':cut' => $cutNotifs]);
                        $deletedNotifs = (int)$st2->rowCount();

                        // Clean up old OAuth state rows (safe + bounded).
                        try {
                            $cutOauth = gmdate('c', time() - (14 * 86400));
                            $st3 = $pdo->prepare('DELETE FROM oauth_states WHERE created_at IS NOT NULL AND created_at < :cut');
                            $st3->execute([':cut' => $cutOauth]);
                            $deletedOauth = (int)$st3->rowCount();
                        } catch (\Throwable $e) {
                            $deletedOauth = 0;
                        }

                        $pdo->commit();
                    } catch (\Throwable $e) {
                        $pdo->rollBack();
                        throw $e;
                    }

                    return $this->json([
                        'ok' => true,
                        'actorDid' => $meDid,
                        'keepDaysPosts' => $keepDaysPosts,
                        'keepDaysNotifs' => $keepDaysNotifs,
                        'cutoffPosts' => $cutPosts,
                        'cutoffNotifs' => $cutNotifs,
                        'deleted' => [
                            'posts' => $deletedPosts,
                            'notifications' => $deletedNotifs,
                            'oauth_states' => $deletedOauth,
                        ],
                    ]);
                }

                case 'cacheMigrateCheck': {
                    // Admin-only migrate + assert schema version.
                    $this->requireSuperUser($jwt);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);
                    $cur = $this->cacheMetaGet($pdo, null, 'schema_version');
                    $ok = ($cur === self::CACHE_SCHEMA_VERSION);
                    return $this->json([
                        'ok' => $ok,
                        'schemaVersion' => $cur,
                        'expected' => self::CACHE_SCHEMA_VERSION,
                        'path' => $this->cacheDbPath(),
                    ], $ok ? 200 : 500);
                }

                case 'cacheExport': {
                    // Export cached data for AI workflows.
                    // Params:
                    // - kind: posts|notifications|followers|following
                    // - format: json|csv
                    // - limit/offset
                    $kind = (string)($params['kind'] ?? 'posts');
                    $format = (string)($params['format'] ?? 'json');
                    if (!in_array($kind, ['posts', 'notifications', 'followers', 'following'], true)) $kind = 'posts';
                    if ($format !== 'csv') $format = 'json';
                    $limit = min(5000, max(1, (int)($params['limit'] ?? 1000)));
                    $offset = max(0, (int)($params['offset'] ?? 0));

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if ($kind === 'posts') {
                        $st = $pdo->prepare('SELECT uri, cid, kind, created_at, indexed_at, raw_json, updated_at FROM posts WHERE actor_did = :a ORDER BY created_at DESC LIMIT :lim OFFSET :off');
                        $st->bindValue(':a', $meDid);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->bindValue(':off', $offset, \PDO::PARAM_INT);
                        $st->execute();
                        $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                        if ($format === 'csv') {
                            $out = "uri,cid,kind,created_at,indexed_at,updated_at\n";
                            foreach ($rows as $r) {
                                $vals = [
                                    (string)($r['uri'] ?? ''),
                                    (string)($r['cid'] ?? ''),
                                    (string)($r['kind'] ?? ''),
                                    (string)($r['created_at'] ?? ''),
                                    (string)($r['indexed_at'] ?? ''),
                                    (string)($r['updated_at'] ?? ''),
                                ];
                                $vals = array_map(static function ($v) {
                                    $v = str_replace('"', '""', (string)$v);
                                    return '"' . $v . '"';
                                }, $vals);
                                $out .= implode(',', $vals) . "\n";
                            }
                            return $this->json(['ok' => true, 'kind' => $kind, 'format' => $format, 'actorDid' => $meDid, 'limit' => $limit, 'offset' => $offset, 'csv' => $out]);
                        }

                        return $this->json(['ok' => true, 'kind' => $kind, 'format' => $format, 'actorDid' => $meDid, 'limit' => $limit, 'offset' => $offset, 'items' => $rows]);
                    }

                    if ($kind === 'followers' || $kind === 'following') {
                        $snap = $this->cacheLatestSnapshotInfo($pdo, $meDid, $kind);
                        if (!$snap) {
                            return $this->json(['ok' => false, 'kind' => $kind, 'error' => 'No snapshot available yet. Run Sync followers/following first.'], 400);
                        }

                        $sid = (int)$snap['id'];
                        $st = $pdo->prepare('SELECT
                                e.other_did,
                                p.handle,
                                p.display_name,
                                p.avatar,
                                p.description,
                                p.created_at,
                                p.followers_count,
                                p.follows_count,
                                p.posts_count,
                                p.updated_at AS profile_updated_at
                            FROM edges e
                            LEFT JOIN profiles p ON p.did = e.other_did
                            WHERE e.snapshot_id = :sid
                            ORDER BY e.other_did ASC
                            LIMIT :lim OFFSET :off');
                        $st->bindValue(':sid', $sid, \PDO::PARAM_INT);
                        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                        $st->bindValue(':off', $offset, \PDO::PARAM_INT);
                        $st->execute();
                        $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                        if ($format === 'csv') {
                            $out = "other_did,handle,display_name,avatar,description,created_at,followers_count,follows_count,posts_count,profile_updated_at\n";
                            foreach ($rows as $r) {
                                $vals = [
                                    (string)($r['other_did'] ?? ''),
                                    (string)($r['handle'] ?? ''),
                                    (string)($r['display_name'] ?? ''),
                                    (string)($r['avatar'] ?? ''),
                                    (string)($r['description'] ?? ''),
                                    (string)($r['created_at'] ?? ''),
                                    (string)($r['followers_count'] ?? ''),
                                    (string)($r['follows_count'] ?? ''),
                                    (string)($r['posts_count'] ?? ''),
                                    (string)($r['profile_updated_at'] ?? ''),
                                ];
                                $vals = array_map(static function ($v) {
                                    $v = str_replace('"', '""', (string)$v);
                                    return '"' . $v . '"';
                                }, $vals);
                                $out .= implode(',', $vals) . "\n";
                            }
                            return $this->json(['ok' => true, 'kind' => $kind, 'format' => $format, 'actorDid' => $meDid, 'snapshot' => $snap, 'limit' => $limit, 'offset' => $offset, 'csv' => $out]);
                        }

                        return $this->json(['ok' => true, 'kind' => $kind, 'format' => $format, 'actorDid' => $meDid, 'snapshot' => $snap, 'limit' => $limit, 'offset' => $offset, 'items' => $rows]);
                    }

                    // notifications
                    $st = $pdo->prepare('SELECT notif_id, indexed_at, reason, author_did, reason_subject, raw_json, updated_at FROM notifications WHERE actor_did = :a AND indexed_at IS NOT NULL ORDER BY indexed_at DESC LIMIT :lim OFFSET :off');
                    $st->bindValue(':a', $meDid);
                    $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
                    $st->bindValue(':off', $offset, \PDO::PARAM_INT);
                    $st->execute();
                    $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

                    if ($format === 'csv') {
                        $out = "notif_id,indexed_at,reason,author_did,reason_subject,updated_at\n";
                        foreach ($rows as $r) {
                            $vals = [
                                (string)($r['notif_id'] ?? ''),
                                (string)($r['indexed_at'] ?? ''),
                                (string)($r['reason'] ?? ''),
                                (string)($r['author_did'] ?? ''),
                                (string)($r['reason_subject'] ?? ''),
                                (string)($r['updated_at'] ?? ''),
                            ];
                            $vals = array_map(static function ($v) {
                                $v = str_replace('"', '""', (string)$v);
                                return '"' . $v . '"';
                            }, $vals);
                            $out .= implode(',', $vals) . "\n";
                        }
                        return $this->json(['ok' => true, 'kind' => $kind, 'format' => $format, 'actorDid' => $meDid, 'limit' => $limit, 'offset' => $offset, 'csv' => $out]);
                    }

                    return $this->json(['ok' => true, 'kind' => $kind, 'format' => $format, 'actorDid' => $meDid, 'limit' => $limit, 'offset' => $offset, 'items' => $rows]);
                }

                case 'search': {
                    // Unified multi-target search endpoint.
                    // Intended for:
                    // - HUD/router (optional)
                    // - automation/MCP (JWT can bypass CSRF)
                    //
                    // Params:
                    // - q: query string
                    // - mode: 'cache' | 'network'
                    // - targets: ['people','posts','feeds','lists','notifications']
                    // - limit: per-target max results
                    // - hours: cache window for posts/notifications
                    // - postTypes: ['post','reply','repost'] (optional)
                    // - reasons: notification reasons (optional)

                    $q = trim((string)($params['q'] ?? ''));
                    $mode = (string)($params['mode'] ?? 'cache');
                    if ($mode !== 'network') $mode = 'cache';

                    $targets = (isset($params['targets']) && is_array($params['targets']))
                        ? array_values(array_unique(array_map('strval', $params['targets'])))
                        : ['people', 'posts', 'feeds', 'notifications'];
                    $targets = array_values(array_filter($targets));
                    if (!$targets) $targets = ['people', 'posts', 'feeds', 'notifications'];

                    $limit = min(200, max(1, (int)($params['limit'] ?? 50)));
                    $hours = min(24 * 365 * 50, max(1, (int)($params['hours'] ?? (24 * 30))));

                    $postTypes = (isset($params['postTypes']) && is_array($params['postTypes']))
                        ? array_values(array_unique(array_map('strval', $params['postTypes'])))
                        : [];
                    $reasons = (isset($params['reasons']) && is_array($params['reasons']))
                        ? array_values(array_unique(array_map('strval', $params['reasons'])))
                        : [];

                    $meDid = $session['did'] ?? null;
                    if (!$meDid) return $this->json(['error' => 'Could not determine session DID'], 500);

                    // Lightweight matcher: supports OR/|, negation (-term), and field:value.
                    $buildMatcher = static function (string $rawQ): array {
                        $rawQ = trim($rawQ);
                        if ($rawQ === '') {
                            return ['ok' => true, 'type' => 'empty'];
                        }

                        // Regex mode: /pattern/i
                        if (strlen($rawQ) >= 2 && $rawQ[0] === '/') {
                            $last = strrpos($rawQ, '/');
                            if ($last !== false && $last > 0) {
                                $pat = substr($rawQ, 1, $last - 1);
                                $flags = substr($rawQ, $last + 1);
                                $flags = $flags !== '' ? $flags : 'i';
                                $re = '/' . str_replace('/', '\\/', $pat) . '/' . $flags;
                                return ['ok' => true, 'type' => 'regex', 're' => $re];
                            }
                        }

                        $norm = preg_replace('/\s+OR\s+/i', ' | ', $rawQ);
                        $orParts = preg_split('/\s*\|\s*/', (string)$norm);
                        $clauses = [];
                        foreach ($orParts as $part) {
                            $part = trim((string)$part);
                            if ($part === '') continue;
                            $bits = preg_split('/\s+/', $part);
                            $terms = [];
                            foreach ($bits as $b) {
                                $b = trim((string)$b);
                                if ($b === '') continue;

                                $neg = false;
                                if ($b[0] === '-' && strlen($b) > 1) {
                                    $neg = true;
                                    $b = substr($b, 1);
                                }

                                $field = null;
                                $val = $b;
                                $idx = strpos($b, ':');
                                if ($idx !== false && $idx > 0) {
                                    $field = strtolower(substr($b, 0, $idx));
                                    $val = substr($b, $idx + 1);
                                }
                                $val = strtolower(trim((string)$val));
                                if ($val === '') continue;

                                $terms[] = ['neg' => $neg, 'field' => $field, 'val' => $val];
                            }
                            if ($terms) $clauses[] = $terms;
                        }
                        return ['ok' => true, 'type' => 'text', 'clauses' => $clauses];
                    };

                    $matcher = $buildMatcher($q);

                    $matches = static function (array $m, string $text, array $fields = []) : bool {
                        if (($m['type'] ?? '') === 'empty') return true;
                        $hay = strtolower($text);

                        if (($m['type'] ?? '') === 'regex') {
                            $blob = $hay . ' ' . strtolower(json_encode($fields, JSON_UNESCAPED_SLASHES));
                            return @preg_match((string)($m['re'] ?? ''), $blob) === 1;
                        }

                        $clauses = $m['clauses'] ?? [];
                        if (!$clauses) {
                            // Fallback: simple substring.
                            return $hay !== '';
                        }

                        // OR over clauses, AND within a clause.
                        foreach ($clauses as $terms) {
                            $ok = true;
                            foreach ($terms as $t) {
                                $val = (string)($t['val'] ?? '');
                                if ($val === '') continue;

                                $field = $t['field'] ?? null;
                                $neg = !empty($t['neg']);

                                $target = $hay;
                                if ($field) {
                                    $fv = $fields[$field] ?? '';
                                    if (is_array($fv)) $fv = implode(' ', array_map('strval', $fv));
                                    $target = strtolower((string)$fv);
                                }

                                $hit = (strpos($target, $val) !== false);
                                if ($neg ? $hit : !$hit) {
                                    $ok = false;
                                    break;
                                }
                            }
                            if ($ok) return true;
                        }

                        return false;
                    };

                    $out = [
                        'ok' => true,
                        'mode' => $mode,
                        'q' => $q,
                        'targets' => $targets,
                        'actorDid' => $meDid,
                        'results' => [],
                    ];

                    $networkPeopleTerm = static function (string $raw): string {
                        $raw = trim($raw);
                        if ($raw === '') return '';

                        // Regex queries are not supported for network search.
                        if (strlen($raw) >= 2 && $raw[0] === '/' && strrpos($raw, '/') > 0) {
                            return '';
                        }

                        $raw = trim($raw, "\"'");
                        $tokens = preg_split('/\s+/', $raw);
                        $picked = [];
                        $allowFields = ['name', 'handle', 'did', 'user', 'displayname', 'display'];

                        foreach ($tokens as $tok) {
                            $tok = trim((string)$tok);
                            if ($tok === '') continue;

                            $upper = strtoupper($tok);
                            if ($upper === 'AND' || $upper === 'OR' || $upper === 'NOT' || $tok === '|' || $tok === '||') continue;
                            if ($tok[0] === '-') continue;

                            if ($tok[0] === '~' && strlen($tok) > 1) $tok = substr($tok, 1);
                            $tok = trim($tok);
                            if ($tok === '') continue;

                            $idx = strpos($tok, ':');
                            if ($idx !== false && $idx > 0) {
                                $field = strtolower(substr($tok, 0, $idx));
                                $val = trim(substr($tok, $idx + 1));
                                $val = ltrim($val, '@');
                                if ($val !== '' && in_array($field, $allowFields, true)) {
                                    $picked[] = $val;
                                }
                                continue;
                            }

                            $tok = ltrim($tok, '@');
                            if ($tok !== '') $picked[] = $tok;
                        }

                        $term = trim(implode(' ', $picked));
                        if ($term === '') $term = $raw;
                        if (strlen($term) > 256) $term = substr($term, 0, 256);
                        return $term;
                    };

                    if ($mode === 'network') {
                        // Network mode: supports people + posts + feeds.
                        // (Notifications are cache-only for now.)
                        $term = $networkPeopleTerm($q);
                        $termOk = !($term === '' || strlen($term) < 2);

                        $out['cursors'] = [];

                        if (in_array('people', $targets, true)) {
                            if (!$termOk) {
                                $out['results']['people'] = [];
                            } else {
                                $res = $this->xrpcSession('GET', 'app.bsky.actor.searchActors', $session, ['term' => $term, 'limit' => $limit]);
                                $out['results']['people'] = $res['actors'] ?? [];
                                $out['cursors']['people'] = $res['cursor'] ?? null;
                            }
                        }

                        if (in_array('posts', $targets, true)) {
                            if (!$termOk) {
                                $out['results']['posts'] = [];
                            } else {
                                $res = $this->xrpcSession('GET', 'app.bsky.feed.searchPosts', $session, ['q' => $term, 'limit' => $limit]);
                                $out['results']['posts'] = $res['posts'] ?? [];
                                $out['cursors']['posts'] = $res['cursor'] ?? null;
                            }
                        }

                        if (in_array('feeds', $targets, true)) {
                            if (!$termOk) {
                                $out['results']['feeds'] = [];
                            } else {
                                // app.bsky.feed.searchFeeds exists on modern Bluesky/PDS.
                                // Some deployments may not expose it; treat as optional.
                                try {
                                    $res = $this->xrpcSession('GET', 'app.bsky.feed.searchFeeds', $session, ['q' => $term, 'limit' => $limit]);
                                    $out['results']['feeds'] = $res['feeds'] ?? [];
                                    $out['cursors']['feeds'] = $res['cursor'] ?? null;
                                } catch (\Throwable $e) {
                                    $out['results']['feeds'] = [];
                                    $out['cursors']['feeds'] = null;
                                    $out['warnings'] = array_values(array_unique(array_merge(
                                        isset($out['warnings']) && is_array($out['warnings']) ? $out['warnings'] : [],
                                        ['Feeds search not available on this server']
                                    )));
                                }
                            }
                        }

                        if (in_array('lists', $targets, true)) {
                            if (!$termOk) {
                                $out['results']['lists'] = [];
                            } else {
                                // app.bsky.graph.searchLists exists on modern appviews.
                                // Some deployments may not expose it; treat as optional.
                                try {
                                    $res = $this->xrpcSession('GET', 'app.bsky.graph.searchLists', $session, ['q' => $term, 'limit' => $limit]);
                                    $out['results']['lists'] = $res['lists'] ?? [];
                                    $out['cursors']['lists'] = $res['cursor'] ?? null;
                                } catch (\Throwable $e) {
                                    $out['results']['lists'] = [];
                                    $out['cursors']['lists'] = null;
                                    $out['warnings'] = array_values(array_unique(array_merge(
                                        isset($out['warnings']) && is_array($out['warnings']) ? $out['warnings'] : [],
                                        ['Lists search not available on this server']
                                    )));
                                }
                            }
                        }

                        // Notifications aren't supported in network mode here.
                        if (in_array('notifications', $targets, true) && !isset($out['results']['notifications'])) {
                            $out['results']['notifications'] = [];
                        }

                        if (in_array('lists', $targets, true) && !isset($out['results']['lists'])) {
                            $out['results']['lists'] = [];
                        }

                        return $this->json($out);
                    }

                    // Cache mode: query cache tables.
                    $pdo = $this->cacheDb();
                    $this->cacheMigrate($pdo);

                    if (in_array('people', $targets, true)) {
                        // cacheQueryPeople already supports q substring; advanced tokens can be matched client-side.
                        $list = isset($params['list']) ? (string)$params['list'] : 'all';
                        if (!in_array($list, ['all', 'followers', 'following'], true)) $list = 'all';
                        $sort = isset($params['sort']) ? (string)$params['sort'] : 'followers';
                        if (!in_array($sort, ['followers', 'following', 'posts', 'age', 'name', 'handle'], true)) $sort = 'followers';
                        $mutual = !empty($params['mutual']);
                        $people = $this->cacheQueryPeople($pdo, $meDid, $list, $q, $sort, $mutual, $limit, 0);
                        $out['results']['people'] = $people['items'] ?? [];
                    }

                    if (in_array('posts', $targets, true)) {
                        $types = $postTypes ?: ['post', 'reply', 'repost'];
                        $items = [];
                        if ($q === '') {
                            $res = $this->cacheQueryMyPosts($pdo, $meDid, null, null, $hours, $types, $limit, 0, true);
                            $items = $res['items'] ?? [];
                        } else {
                            // Pull a best-effort positive search term for FTS/LIKE.
                            $term = trim((string)$q);
                            try {
                                $allowFields = ['type', 'uri'];
                                $bits = preg_split('/\s+/', $term);
                                $picked = [];
                                foreach ($bits as $b) {
                                    $b = trim((string)$b);
                                    if ($b === '') continue;
                                    if ($b[0] === '-') continue;
                                    $idx = strpos($b, ':');
                                    if ($idx !== false && $idx > 0) {
                                        $field = strtolower(substr($b, 0, $idx));
                                        if (in_array($field, $allowFields, true)) continue;
                                    }
                                    $picked[] = $b;
                                }
                                $term = trim(implode(' ', $picked));
                            } catch (\Throwable $e) {
                                $term = trim((string)$q);
                            }

                            $cutoffIso = gmdate('c', time() - ($hours * 3600));
                            $in = [];
                            $bind = [':actor_did' => $meDid, ':cutoff' => $cutoffIso, ':limit' => $limit];
                            foreach ($types as $i => $t) {
                                $k = ':t' . $i;
                                $in[] = $k;
                                $bind[$k] = $t;
                            }
                            $typeWhere = $in ? (' AND p.kind IN (' . implode(',', $in) . ')') : '';

                            $rows = [];
                            // Prefer FTS if available.
                            $usedFts = false;
                            if ($term !== '' && strlen($term) >= 2) {
                                try {
                                    $ftsQ = $this->cacheFtsQuery($term);
                                    $sql = 'SELECT p.raw_json FROM posts_fts f '
                                        . 'JOIN posts p ON p.rowid = f.rowid '
                                        . 'WHERE p.actor_did = :actor_did AND p.created_at >= :cutoff' . $typeWhere
                                        . ' AND f.text MATCH :q '
                                        . 'ORDER BY p.created_at DESC LIMIT :limit';
                                    $st = $pdo->prepare($sql);
                                    foreach ($bind as $k => $v) {
                                        if ($k === ':limit') continue;
                                        $st->bindValue($k, $v);
                                    }
                                    $st->bindValue(':q', $ftsQ);
                                    $st->bindValue(':limit', $limit, \PDO::PARAM_INT);
                                    $st->execute();
                                    $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                                    $usedFts = true;
                                } catch (\Throwable $e) {
                                    $rows = [];
                                }
                            }

                            if (!$usedFts) {
                                $like = '%' . $term . '%';
                                $sql = 'SELECT raw_json FROM posts p '
                                    . 'WHERE p.actor_did = :actor_did AND p.created_at >= :cutoff' . $typeWhere
                                    . ' AND (COALESCE(p.text, "") LIKE :like OR p.uri LIKE :like OR COALESCE(p.raw_json, "") LIKE :like) '
                                    . 'ORDER BY p.created_at DESC LIMIT :limit';
                                $st = $pdo->prepare($sql);
                                foreach ($bind as $k => $v) {
                                    if ($k === ':limit') continue;
                                    $st->bindValue($k, $v);
                                }
                                $st->bindValue(':like', $like);
                                $st->bindValue(':limit', $limit, \PDO::PARAM_INT);
                                $st->execute();
                                $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
                            }

                            foreach ($rows as $r) {
                                $raw = !empty($r['raw_json']) ? json_decode((string)$r['raw_json'], true) : null;
                                if ($raw) $items[] = $raw;
                            }

                            // Apply full matcher (supports negation and field tokens).
                            $items = array_values(array_filter($items, static function ($it) use ($matcher, $matches) {
                                $text = (string)($it['post']['record']['text'] ?? '');
                                $uri = (string)($it['post']['uri'] ?? '');
                                $kind = '';
                                try {
                                    if (!empty($it['reason']['$type']) && stripos((string)$it['reason']['$type'], 'Repost') !== false) $kind = 'repost';
                                    elseif (!empty($it['post']['record']['reply'])) $kind = 'reply';
                                    else $kind = 'post';
                                } catch (\Throwable $e) {
                                    $kind = '';
                                }
                                $fields = [
                                    'type' => $kind,
                                    'uri' => $uri,
                                ];
                                return $matches($matcher, $text . ' ' . $uri . ' ' . $kind, $fields);
                            }));
                        }

                        $out['results']['posts'] = $items;
                    }

                    if (in_array('feeds', $targets, true)) {
                        // No cache table for feeds yet.
                        $out['results']['feeds'] = [];
                    }

                    if (in_array('lists', $targets, true)) {
                        // No cache table for lists yet.
                        $out['results']['lists'] = [];
                    }

                    if (in_array('notifications', $targets, true)) {
                        $useReasons = $reasons;
                        if (!$useReasons) {
                            $useReasons = ['follow','like','reply','repost','mention','quote','subscribed-post','subscribed'];
                        }
                        $res = $this->cacheQueryNotifications($pdo, $meDid, null, null, $hours, $useReasons, $limit, 0, true);
                        $items = $res['items'] ?? [];
                        if ($q !== '') {
                            $items = array_values(array_filter($items, static function ($n) use ($matcher, $matches) {
                                $who = (string)($n['authorDisplayName'] ?? $n['authorHandle'] ?? $n['authorDid'] ?? '');
                                $reason = (string)($n['reason'] ?? '');
                                $subject = (string)($n['reasonSubject'] ?? '');
                                $text = trim($who . ' ' . $reason . ' ' . $subject);
                                $fields = [
                                    'reason' => $reason,
                                    'subject' => $subject,
                                    'handle' => (string)($n['authorHandle'] ?? ''),
                                    'did' => (string)($n['authorDid'] ?? ''),
                                ];
                                return $matches($matcher, $text, $fields);
                            }));
                        }
                        $out['results']['notifications'] = $items;
                    }

                    // Convenience counts.
                    $out['counts'] = [
                        'people' => isset($out['results']['people']) ? count((array)$out['results']['people']) : 0,
                        'posts' => isset($out['results']['posts']) ? count((array)$out['results']['posts']) : 0,
                        'lists' => isset($out['results']['lists']) ? count((array)$out['results']['lists']) : 0,
                        'notifications' => isset($out['results']['notifications']) ? count((array)$out['results']['notifications']) : 0,
                    ];

                    return $this->json($out);
                }

                default:
                    // Explicitly include method/params in debug for easier client troubleshooting
                    return $this->json(['error' => 'Unknown method', 'debug' => $this->debug ? compact('method', 'params') : null], 400);
            }
        } catch (\Throwable $e) {
			if ($this->debug) {
                Log::debug('[BSKY api exception] ' . $e->getMessage());
			}
            $code = 500;
            if (is_int($e->getCode()) && $e->getCode() >= 400 && $e->getCode() <= 599) {
                $code = (int)$e->getCode();
            }
            $msg = (string)$e->getMessage();
            // Provide a clearer error for missing SQLite PDO driver.
            if (stripos($msg, 'could not find driver') !== false || stripos($msg, 'pdo_sqlite') !== false) {
                $code = 503;
                $msg = 'SQLite cache is unavailable (PDO SQLite driver missing). Install php8.3-sqlite3 (or php-sqlite3) and restart php-fpm/nginx.';
            }
			if (preg_match('/HTTP\s+(\d{3})/i', $e->getMessage(), $m)) {
				$code = (int)$m[1];
			}
            return $this->json(['error' => $msg], $code);
		}
    }

    /* ===================== helpers ===================== */

    /** Chunk an array to satisfy Bluesky size limits (e.g., actors<=25). */
    protected function chunkArray(array $arr, int $size = 25): array
    {
        if ($size < 1) $size = 25;
        return array_chunk($arr, $size);
    }

    /** Find the rkey for an existing follow(subject=did) in your repo. */
    protected function findFollowRkey($session, $subjectDid)
    {
        $cursor = null;
        do {
            $data = $this->listRecords($session, 'app.bsky.graph.follow', 100, $cursor);
            foreach ($data['records'] ?? [] as $rec) {
                if (($rec['value']['subject'] ?? null) === $subjectDid) {
                    return $rec['rkey'] ?? null;
                }
            }
            $cursor = $data['cursor'] ?? null;
        } while ($cursor);
        return null;
    }

    /** Find the rkey for an existing block(subject=did) in your repo. */
    protected function findBlockRkey($session, $subjectDid)
    {
        $cursor = null;
        do {
            $data = $this->listRecords($session, 'app.bsky.graph.block', 100, $cursor);
            foreach ($data['records'] ?? [] as $rec) {
                if (($rec['value']['subject'] ?? null) === $subjectDid) {
                    return $rec['rkey'] ?? null;
                }
            }
            $cursor = $data['cursor'] ?? null;
        } while ($cursor);
        return null;
    }

    /**
     * Find rkey for like/repost record whose subject matches uri (and optionally cid).
     */
    protected function findEngagementRkey($session, $collection, $uri, $cid = null)
    {
        $cursor = null;
        do {
            $data = $this->listRecords($session, $collection, 100, $cursor);
            foreach ($data['records'] ?? [] as $rec) {
                $subj = $rec['value']['subject'] ?? [];
                if (($subj['uri'] ?? null) === $uri && ($cid === null || ($subj['cid'] ?? null) === $cid)) {
                    return $rec['rkey'] ?? null;
                }
            }
            $cursor = $data['cursor'] ?? null;
        } while ($cursor);
        return null;
    }

    /** Extract record key from an at:// URI (last path segment). */
    protected function rkeyFromAtUri($uri)
    {
        if (preg_match('#/([^/]+)$#', (string)$uri, $m)) {
            return $m[1];
        }
        return null;
    }

    /** Normalize a relationship row from graph.getRelationships into booleans + URIs. */
    protected function normalizeRelationship(array $r): array
    {
        $did = $r['did'] ?? ($r['subject'] ?? null);
        $viewer = $r['viewer'] ?? $r; // sometimes flags sit at top-level
        return [
            'did'           => $did,
            'following'     => !empty($viewer['following']),
            'followingUri'  => $viewer['following'] ?? null,
            'followedBy'    => !empty($viewer['followedBy']),
            'followedByUri' => $viewer['followedBy'] ?? null,
            'muted'         => (bool)($viewer['muted'] ?? false),
            'blocking'      => !empty($viewer['blocking']),
            'blockingUri'   => $viewer['blocking'] ?? null,
            'blockedBy'     => (bool)($viewer['blockedBy'] ?? false),
        ];
    }

    /** Build a relationship row from a profile's viewer block (fallback path). */
    protected function relationshipFromProfile(array $p): array
    {
        $viewer = $p['viewer'] ?? [];
        return [
            'did'           => $p['did'] ?? null,
            'following'     => !empty($viewer['following']),
            'followingUri'  => $viewer['following'] ?? null,
            'followedBy'    => !empty($viewer['followedBy']),
            'followedByUri' => $viewer['followedBy'] ?? null,
            'muted'         => (bool)($viewer['muted'] ?? false),
            'blocking'      => !empty($viewer['blocking']),
            'blockingUri'   => $viewer['blocking'] ?? null,
            'blockedBy'     => (bool)($viewer['blockedBy'] ?? false),
        ];
    }

    /** De-dupe relationship rows by DID (last write wins). */
    protected function dedupeRelationships(array $rows): array
    {
        $out = [];
        foreach ($rows as $r) {
            $did = $r['did'] ?? null;
            if ($did) $out[$did] = $r;
        }
        return array_values($out);
    }

    /** Small sugar for consistent JSON responses. */
    protected function json($data, $code = 200)
    {
        return new JsonResponse($data, $code);
    }

    /** Extract DID from an at:// URI’s host segment. */
    protected function didFromAtUri($uri)
    {
        if (preg_match('#^at://([^/]+)/#', (string)$uri, $m)) {
            return $m[1];
        }
        return null;
    }

    /* ===================== follow queue + rate limits ===================== */

    protected function parseRetryAfterSeconds(?string $raw): ?int
    {
        $raw = trim((string)$raw);
        if ($raw === '') return null;

        if (ctype_digit($raw)) {
            $n = (int)$raw;
            return $n > 0 ? $n : null;
        }

        $ts = strtotime($raw);
        if ($ts === false) return null;
        $sec = $ts - time();
        return $sec > 0 ? $sec : null;
    }

    protected function retryAfterFromException(\Throwable $e): ?int
    {
        $msg = (string)($e->getMessage() ?? '');
        if (!preg_match('/retry-after:\s*([^\)\s]+)/i', $msg, $m)) return null;
        return $this->parseRetryAfterSeconds($m[1] ?? null);
    }

    protected function isRateLimitException(\Throwable $e): bool
    {
        $msg = (string)($e->getMessage() ?? '');
        return (stripos($msg, 'HTTP 429') !== false);
    }

    protected function followQueueStatusInternal(\PDO $pdo, string $actorDid): array
    {
        $counts = ['pending' => 0, 'done' => 0, 'failed' => 0];
        try {
            $st = $pdo->prepare('SELECT state, COUNT(*) AS c FROM follow_queue WHERE actor_did = :a GROUP BY state');
            $st->execute([':a' => $actorDid]);
            foreach ($st->fetchAll(\PDO::FETCH_ASSOC) ?: [] as $row) {
                $state = (string)($row['state'] ?? '');
                $c = (int)($row['c'] ?? 0);
                if (isset($counts[$state])) $counts[$state] = $c;
            }
        } catch (\Throwable $e) {
            // ignore
        }

        $nextAttemptAt = null;
        try {
            $st = $pdo->prepare('SELECT MIN(next_attempt_at) FROM follow_queue WHERE actor_did = :a AND state = "pending" AND next_attempt_at IS NOT NULL');
            $st->execute([':a' => $actorDid]);
            $v = $st->fetchColumn();
            if ($v !== false && $v !== null && (string)$v !== '') $nextAttemptAt = (string)$v;
        } catch (\Throwable $e) {
            $nextAttemptAt = null;
        }

        $rateUntil = $this->cacheMetaGet($pdo, $actorDid, 'follow_rate_until');
        $windowStart = $this->cacheMetaGet($pdo, $actorDid, 'follow_rate_window_start');
        $windowCount = $this->cacheMetaGet($pdo, $actorDid, 'follow_rate_count');

        return [
            'counts' => $counts,
            'pending' => $counts['pending'],
            'done' => $counts['done'],
            'failed' => $counts['failed'],
            'nextAttemptAt' => $nextAttemptAt,
            'rateLimitedUntil' => $rateUntil,
            'windowStart' => $windowStart,
            'windowCount' => ($windowCount !== null ? (int)$windowCount : null),
        ];
    }

    protected function processFollowQueueInternal(\PDO $pdo, array &$session, string $actorDid, int $max = 50): array
    {
        $max = min(500, max(1, (int)$max));

        $limitPerHour = $this->envInt('CONCRETESKY_FOLLOW_MAX_PER_HOUR', 2500, 1, 100000);
        $max = min($max, $this->envInt('CONCRETESKY_FOLLOW_MAX_PER_RUN', 100, 1, 500));

        $now = time();
        $nowIso = gmdate('c', $now);

        // Hard rate-limited until…
        $untilIso = $this->cacheMetaGet($pdo, $actorDid, 'follow_rate_until');
        if ($untilIso) {
            try {
                $untilTs = (new \DateTimeImmutable($untilIso))->getTimestamp();
                if ($untilTs > $now) {
                    return [
                        'ok' => true,
                        'skipped' => true,
                        'reason' => 'rateLimited',
                        'rateLimitedUntil' => $untilIso,
                        'processed' => 0,
                        'results' => [],
                    ];
                }
            } catch (\Throwable $e) {
                // ignore
            }
        }

        // Per-hour budget window.
        $winStartIso = $this->cacheMetaGet($pdo, $actorDid, 'follow_rate_window_start');
        $winCountRaw = $this->cacheMetaGet($pdo, $actorDid, 'follow_rate_count');
        $winStartTs = null;
        if ($winStartIso) {
            try { $winStartTs = (new \DateTimeImmutable($winStartIso))->getTimestamp(); } catch (\Throwable $e) { $winStartTs = null; }
        }
        $winCount = ($winCountRaw !== null) ? (int)$winCountRaw : 0;
        if ($winStartTs === null || ($now - $winStartTs) >= 3600) {
            $winStartTs = $now;
            $winCount = 0;
            $winStartIso = $nowIso;
            $this->cacheMetaSet($pdo, $actorDid, 'follow_rate_window_start', $winStartIso);
            $this->cacheMetaSet($pdo, $actorDid, 'follow_rate_count', (string)$winCount);
        }
        if ($winCount >= $limitPerHour) {
            $untilTs = $winStartTs + 3600;
            $untilIso = gmdate('c', $untilTs);
            $this->cacheMetaSet($pdo, $actorDid, 'follow_rate_until', $untilIso);
            return [
                'ok' => true,
                'skipped' => true,
                'reason' => 'budget',
                'rateLimitedUntil' => $untilIso,
                'processed' => 0,
                'results' => [],
            ];
        }

        $results = [];
        $processed = 0;
        $rateLimitedUntilOut = null;

        $st = $pdo->prepare('SELECT target_did, attempts FROM follow_queue
            WHERE actor_did = :a AND state = "pending" AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
            ORDER BY created_at ASC
            LIMIT :lim');
        $st->bindValue(':a', $actorDid, \PDO::PARAM_STR);
        $st->bindValue(':now', $nowIso, \PDO::PARAM_STR);
        $st->bindValue(':lim', $max, \PDO::PARAM_INT);
        $st->execute();
        $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

        $stOk = $pdo->prepare('UPDATE follow_queue SET state="done", follow_uri=:u, attempts=:att, last_error=NULL, next_attempt_at=NULL, updated_at=:ts WHERE actor_did=:a AND target_did=:t');
        $stFail = $pdo->prepare('UPDATE follow_queue SET state=:s, attempts=:att, last_error=:e, next_attempt_at=:n, updated_at=:ts WHERE actor_did=:a AND target_did=:t');

        foreach ($rows as $row) {
            if ($processed >= $max) break;
            if ($winCount >= $limitPerHour) {
                $untilTs = $winStartTs + 3600;
                $rateLimitedUntilOut = gmdate('c', $untilTs);
                $this->cacheMetaSet($pdo, $actorDid, 'follow_rate_until', $rateLimitedUntilOut);
                break;
            }

            $targetDid = trim((string)($row['target_did'] ?? ''));
            if ($targetDid === '') continue;

            $attempts = (int)($row['attempts'] ?? 0);
            $attemptsNext = $attempts + 1;

            try {
                $rec = ['subject' => $targetDid, 'createdAt' => gmdate('c')];
                $resp = $this->createRecord($session, 'app.bsky.graph.follow', $rec);
                $uri = isset($resp['uri']) ? (string)$resp['uri'] : null;
                $stOk->execute([':u' => $uri, ':att' => $attemptsNext, ':ts' => $nowIso, ':a' => $actorDid, ':t' => $targetDid]);
                $results[$targetDid] = ['ok' => true, 'uri' => $uri];
                $processed++;
                $winCount++;
            } catch (\Throwable $e) {
                $msg = (string)($e->getMessage() ?? 'Follow failed');
                if ($this->isRateLimitException($e)) {
                    $ra = $this->retryAfterFromException($e);
                    $wait = ($ra !== null) ? min(86400, max(1, $ra)) : 10;
                    $nextIso = gmdate('c', time() + $wait);
                    $rateLimitedUntilOut = $nextIso;
                    $this->cacheMetaSet($pdo, $actorDid, 'follow_rate_until', $nextIso);
                    $stFail->execute([':s' => 'pending', ':att' => $attemptsNext, ':e' => $msg, ':n' => $nextIso, ':ts' => $nowIso, ':a' => $actorDid, ':t' => $targetDid]);
                    $results[$targetDid] = ['ok' => false, 'error' => $msg, 'rateLimited' => true, 'retryAt' => $nextIso];
                    // Stop processing further; we hit a real server rate limit.
                    break;
                }

                // For non-rate errors, retry a couple times then mark failed.
                $state = ($attemptsNext >= 3) ? 'failed' : 'pending';
                $nextIso = ($state === 'pending') ? gmdate('c', time() + 30) : null;
                $stFail->execute([':s' => $state, ':att' => $attemptsNext, ':e' => $msg, ':n' => $nextIso, ':ts' => $nowIso, ':a' => $actorDid, ':t' => $targetDid]);
                $results[$targetDid] = ['ok' => false, 'error' => $msg, 'retryAt' => $nextIso];
                $processed++;
            }
        }

        $this->cacheMetaSet($pdo, $actorDid, 'follow_rate_count', (string)$winCount);
        $this->cacheMetaSet($pdo, $actorDid, 'follow_queue_last_run_at', $nowIso);

        return [
            'ok' => true,
            'skipped' => false,
            'processed' => $processed,
            'results' => $results,
            'rateLimitedUntil' => $rateLimitedUntilOut,
            'budget' => [
                'limitPerHour' => $limitPerHour,
                'windowStart' => $winStartIso,
                'windowCount' => $winCount,
            ],
        ];
    }

    /* ===================== scheduled posts ===================== */

    protected function parseIsoToTimestamp(?string $iso): ?int
    {
        $iso = trim((string)$iso);
        if ($iso === '') return null;
        try {
            $dt = new \DateTimeImmutable($iso);
            return $dt->getTimestamp();
        } catch (\Throwable $e) {
            return null;
        }
    }

    protected function scheduledPostsListInternal(\PDO $pdo, string $actorDid, int $limit = 50, bool $includeDone = false): array
    {
        $limit = min(200, max(1, (int)$limit));
        $actorDid = trim((string)$actorDid);
        if ($actorDid === '') return [];

        $where = 'actor_did = :a';
        if (!$includeDone) {
            $where .= ' AND state IN ("pending","posting","failed","error")';
        }

        $st = $pdo->prepare('SELECT id, actor_did, state, kind, scheduled_at, payload_json, attempts, last_error, next_attempt_at, result_uri, result_cid, created_at, updated_at
            FROM scheduled_posts
            WHERE ' . $where . '
            ORDER BY scheduled_at ASC, id ASC
            LIMIT :lim');
        $st->bindValue(':a', $actorDid, \PDO::PARAM_STR);
        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
        $st->execute();
        $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

        // Do not expose full payload by default (can include blobs); keep it server-only.
        foreach ($rows as &$r) {
            unset($r['payload_json']);
        }
        return $rows;
    }

    protected function processScheduledPostsInternal(\PDO $pdo, array &$session, string $actorDid, int $max = 25): array
    {
        $actorDid = trim((string)$actorDid);
        $max = min(200, max(1, (int)$max));
        if ($actorDid === '') return ['ok' => false, 'error' => 'Missing actorDid'];

        $now = time();
        $nowIso = gmdate('c', $now);
        $stalePostingIso = gmdate('c', $now - 600);

        // Pull due work. Include stale "posting" rows as recovery.
        $st = $pdo->prepare('SELECT id, kind, scheduled_at, payload_json, attempts
            FROM scheduled_posts
            WHERE actor_did = :a
              AND (
                (state = "pending" AND scheduled_at <= :now AND (next_attempt_at IS NULL OR next_attempt_at <= :now))
                OR (state = "posting" AND updated_at IS NOT NULL AND updated_at <= :stale)
              )
            ORDER BY scheduled_at ASC, id ASC
            LIMIT :lim');
        $st->bindValue(':a', $actorDid, \PDO::PARAM_STR);
        $st->bindValue(':now', $nowIso, \PDO::PARAM_STR);
        $st->bindValue(':stale', $stalePostingIso, \PDO::PARAM_STR);
        $st->bindValue(':lim', $max, \PDO::PARAM_INT);
        $st->execute();
        $rows = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

        $processed = 0;
        $posted = 0;
        $errors = 0;
        $results = [];

        $stMarkPosting = $pdo->prepare('UPDATE scheduled_posts SET state="posting", last_error=NULL, updated_at=:u WHERE actor_did=:a AND id=:id');
        $stOk = $pdo->prepare('UPDATE scheduled_posts SET state="posted", attempts=:att, last_error=NULL, next_attempt_at=NULL, result_uri=:uri, result_cid=:cid, updated_at=:u WHERE actor_did=:a AND id=:id');
        $stFail = $pdo->prepare('UPDATE scheduled_posts SET state=:s, attempts=:att, last_error=:e, next_attempt_at=:n, updated_at=:u WHERE actor_did=:a AND id=:id');

        foreach ($rows as $row) {
            if ($processed >= $max) break;
            $id = (int)($row['id'] ?? 0);
            if ($id <= 0) continue;

            $attempts = (int)($row['attempts'] ?? 0);
            $attemptsNext = $attempts + 1;

            try {
                $stMarkPosting->execute([':u' => $nowIso, ':a' => $actorDid, ':id' => $id]);

                $kind = strtolower(trim((string)($row['kind'] ?? 'post')));
                $payloadRaw = (string)($row['payload_json'] ?? '');
                $payload = $payloadRaw !== '' ? (json_decode($payloadRaw, true) ?: null) : null;
                if (!is_array($payload)) {
                    throw new \RuntimeException('Invalid payload_json');
                }

                $interactions = (isset($payload['interactions']) && is_array($payload['interactions'])) ? $payload['interactions'] : null;

                $applyGates = function(?string $createdUri, bool $isRootPost) use (&$session, $interactions): void {
                    $uri = trim((string)$createdUri);
                    if ($uri === '' || !is_array($interactions)) return;

                    // Postgate: disable embedding/quotes.
                    try {
                        $quotesAllowed = $interactions['quotes']['allow'] ?? null;
                        if ($quotesAllowed === false) {
                            $rkey = $this->rkeyFromAtUri($uri);
                            if ($rkey) {
                                $rec = [
                                    '$type' => 'app.bsky.feed.postgate',
                                    'post' => $uri,
                                    'createdAt' => gmdate('c'),
                                    'embeddingRules' => [
                                        ['$type' => 'app.bsky.feed.postgate#disableRule'],
                                    ],
                                ];
                                $this->createRecord($session, 'app.bsky.feed.postgate', $rec, $rkey);
                            }
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }

                    // Threadgate: reply controls apply to the root post only.
                    if (!$isRootPost) return;
                    try {
                        $reply = $interactions['reply'] ?? null;
                        if (!is_array($reply)) return;
                        $mode = strtolower(trim((string)($reply['mode'] ?? 'everyone')));
                        if ($mode === 'everyone') return;

                        $allowIn = ($mode === 'nobody') ? [] : ($reply['allow'] ?? null);
                        if ($mode === 'custom' && !is_array($allowIn)) $allowIn = [];
                        if ($mode !== 'custom' && $mode !== 'nobody') return;

                        $allow = [];
                        if (is_array($allowIn)) {
                            foreach ($allowIn as $rule) {
                                $t = strtolower(trim((string)$rule));
                                if ($t === 'mention' || $t === 'mentions' || $t === 'mentionrule') {
                                    $allow[] = ['$type' => 'app.bsky.feed.threadgate#mentionRule'];
                                } elseif ($t === 'follower' || $t === 'followers' || $t === 'followerrule') {
                                    $allow[] = ['$type' => 'app.bsky.feed.threadgate#followerRule'];
                                } elseif ($t === 'following' || $t === 'followingrule') {
                                    $allow[] = ['$type' => 'app.bsky.feed.threadgate#followingRule'];
                                } elseif ($t === 'list' || $t === 'listrule') {
                                    $listUri = trim((string)($reply['listUri'] ?? ''));
                                    if ($listUri === '') continue;
                                    $allow[] = ['$type' => 'app.bsky.feed.threadgate#listRule', 'list' => $listUri];
                                }
                            }
                        }

                        $rkey = $this->rkeyFromAtUri($uri);
                        if (!$rkey) return;
                        $rec = [
                            '$type' => 'app.bsky.feed.threadgate',
                            'post' => $uri,
                            'createdAt' => gmdate('c'),
                            'allow' => array_values($allow),
                        ];
                        $this->createRecord($session, 'app.bsky.feed.threadgate', $rec, $rkey);
                    } catch (\Throwable $e) {
                        // ignore
                    }
                };

                $rootCreated = null;

                if ($kind === 'thread') {
                    $parts = (isset($payload['parts']) && is_array($payload['parts'])) ? $payload['parts'] : [];
                    $parts = array_slice($parts, 0, 10);
                    if (!$parts) {
                        throw new \RuntimeException('Missing parts');
                    }

                    $rootRef = null;
                    $parentRef = null;
                    for ($i = 0; $i < count($parts); $i++) {
                        $p = $parts[$i];
                        if (!is_array($p)) continue;
                        $text = (string)($p['text'] ?? '');
                        $text = trim($text);
                        if ($text === '') continue;

                        $record = [
                            '$type' => 'app.bsky.feed.post',
                            'text' => $text,
                            'createdAt' => gmdate('c'),
                        ];
                        if (!empty($p['langs']) && is_array($p['langs'])) $record['langs'] = array_values($p['langs']);
                        if (!empty($p['facets']) && is_array($p['facets'])) $record['facets'] = $p['facets'];
                        if (!empty($p['embed']) && is_array($p['embed'])) $record['embed'] = $p['embed'];

                        if ($i > 0 && is_array($rootRef) && is_array($parentRef)) {
                            $record['reply'] = [
                                'root' => $rootRef,
                                'parent' => $parentRef,
                            ];
                        }

                        $resp = $this->createRecord($session, 'app.bsky.feed.post', $record);
                        $uri = isset($resp['uri']) ? (string)$resp['uri'] : '';
                        $cid = isset($resp['cid']) ? (string)$resp['cid'] : '';

                        if ($i === 0) {
                            $rootCreated = ['uri' => $uri, 'cid' => $cid];
                            $rootRef = ['uri' => $uri, 'cid' => $cid];
                        }
                        $parentRef = ['uri' => $uri, 'cid' => $cid];

                        $applyGates($uri, $i === 0);
                    }

                    if (!$rootCreated || empty($rootCreated['uri'])) {
                        throw new \RuntimeException('Thread post failed');
                    }
                } else {
                    $post = (isset($payload['post']) && is_array($payload['post'])) ? $payload['post'] : null;
                    if (!is_array($post)) {
                        throw new \RuntimeException('Missing post');
                    }
                    $text = trim((string)($post['text'] ?? ''));
                    if ($text === '') throw new \RuntimeException('Missing text');

                    $record = [
                        '$type' => 'app.bsky.feed.post',
                        'text' => $text,
                        'createdAt' => gmdate('c'),
                    ];
                    if (!empty($post['langs']) && is_array($post['langs'])) $record['langs'] = array_values($post['langs']);
                    if (!empty($post['facets']) && is_array($post['facets'])) $record['facets'] = $post['facets'];
                    if (!empty($post['embed']) && is_array($post['embed'])) $record['embed'] = $post['embed'];

                    $resp = $this->createRecord($session, 'app.bsky.feed.post', $record);
                    $uri = isset($resp['uri']) ? (string)$resp['uri'] : '';
                    $cid = isset($resp['cid']) ? (string)$resp['cid'] : '';
                    $rootCreated = ['uri' => $uri, 'cid' => $cid];

                    $applyGates($uri, true);
                }

                $stOk->execute([
                    ':att' => $attemptsNext,
                    ':uri' => (string)($rootCreated['uri'] ?? ''),
                    ':cid' => (string)($rootCreated['cid'] ?? ''),
                    ':u' => $nowIso,
                    ':a' => $actorDid,
                    ':id' => $id,
                ]);

                $processed++;
                $posted++;
                $results[] = ['id' => $id, 'ok' => true, 'uri' => (string)($rootCreated['uri'] ?? ''), 'cid' => (string)($rootCreated['cid'] ?? '')];
            } catch (\Throwable $e) {
                $processed++;
                $errors++;

                $msg = (string)($e->getMessage() ?? 'Scheduled post failed');

                // Conservative retry: a few attempts with backoff, then mark error.
                $state = ($attemptsNext >= 3) ? 'error' : 'pending';
                $nextIso = null;
                if ($state === 'pending') {
                    $wait = 60 * (int)pow(2, max(0, $attemptsNext - 1));
                    $wait = min(3600, max(60, $wait));
                    $nextIso = gmdate('c', time() + $wait);
                }

                try {
                    $stFail->execute([
                        ':s' => $state,
                        ':att' => $attemptsNext,
                        ':e' => $msg,
                        ':n' => $nextIso,
                        ':u' => $nowIso,
                        ':a' => $actorDid,
                        ':id' => $id,
                    ]);
                } catch (\Throwable $e2) {
                    // ignore
                }
                $results[] = ['id' => $id, 'ok' => false, 'error' => $msg, 'retryAt' => $nextIso];
            }
        }

        return [
            'ok' => true,
            'processed' => $processed,
            'posted' => $posted,
            'errors' => $errors,
            'results' => $results,
        ];
    }

    /* ===================== SQLite cache helpers ===================== */

    protected function legacyCacheDbPaths(): array
    {
        $appDir = defined('DIR_APPLICATION')
            ? (string)DIR_APPLICATION
            : (defined('DIR_BASE') ? (rtrim((string)DIR_BASE, '/') . '/application') : (dirname(__DIR__, 4) . '/application'));

        $paths = [];

        // Legacy: historical default (bluesky_feed)
        $paths[] = rtrim($appDir, '/') . '/files/bluesky_feed/cache.sqlite';

        // Legacy: previous default for this package.
        $paths[] = rtrim($appDir, '/') . '/files/concretesky/cache.sqlite';

        // Legacy: allow folks who used the old subdir var to still migrate cleanly.
        $legacySubdir = (string)(getenv('BSKY_STORAGE_SUBDIR') ?: '');
        $legacySubdir = trim($legacySubdir, "/\t\n\r\0\x0B/");
        if ($legacySubdir !== '' && $legacySubdir !== 'concretesky' && $legacySubdir !== 'bluesky_feed') {
            $paths[] = rtrim($appDir, '/') . '/files/' . $legacySubdir . '/cache.sqlite';
        }

        // De-dupe
        $uniq = [];
        foreach ($paths as $p) {
            $p = (string)$p;
            if ($p === '') continue;
            $uniq[$p] = true;
        }
        return array_keys($uniq);
    }

    protected function migrateLegacyCacheDbIfNeeded(string $targetPath): void
    {
        if (is_file($targetPath)) {
            return;
        }

        $targetDir = dirname($targetPath);
        if (!is_dir($targetDir)) {
            @mkdir($targetDir, 0775, true);
        }

        foreach ($this->legacyCacheDbPaths() as $legacyPath) {
            if (!is_file($legacyPath)) continue;

            // Avoid self-migration.
            if (realpath($legacyPath) && realpath($targetPath) && realpath($legacyPath) === realpath($targetPath)) {
                return;
            }

            $copyOrMove = static function (string $from, string $to): void {
                if (!is_file($from)) return;
                if (@rename($from, $to)) return;
                if (@copy($from, $to)) {
                    try {
                        $a = @filesize($from);
                        $b = @filesize($to);
                        if ($a !== false && $b !== false && (int)$a === (int)$b) {
                            @unlink($from);
                        }
                    } catch (\Throwable $e) {
                        // ignore
                    }
                }
            };

            // Move/copy main DB plus WAL/SHM sidecars if present.
            $copyOrMove($legacyPath, $targetPath);
            $copyOrMove($legacyPath . '-wal', $targetPath . '-wal');
            $copyOrMove($legacyPath . '-shm', $targetPath . '-shm');
            return;
        }
    }

    protected function cacheDir(): string
    {
        // Prefer a non-public directory for the SQLite cache.
        // Default: inside the package (we also drop a deny rule in /db).
        // Optional override: point this anywhere writable (recommended for production).
        $override = getenv('CONCRETESKY_CACHE_DIR');
        if ($override !== false && $override !== null && $override !== '') {
            $override = trim((string)$override);
            if ($override !== '') {
                return rtrim($override, '/');
            }
        }

        $packageRoot = dirname(__DIR__, 3);
        return rtrim((string)$packageRoot, '/') . '/db';
    }

    protected function cacheDbPath(): string
    {
        return $this->cacheDir() . '/cache.sqlite';
    }

    protected function cacheDb(): \PDO
    {
        $dir = $this->cacheDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        @chmod($dir, 0775);
        $path = $this->cacheDbPath();

        // If an older install already has a cache.sqlite under application/files, migrate it.
        $this->migrateLegacyCacheDbIfNeeded($path);

        if (!in_array('sqlite', \PDO::getAvailableDrivers(), true)) {
            throw new \RuntimeException('PDO SQLite driver missing (pdo_sqlite)');
        }

        if (!is_writable($dir)) {
            throw new \RuntimeException('SQLite cache directory is not writable: ' . $dir);
        }

        if (file_exists($path) && !is_writable($path)) {
            throw new \RuntimeException('SQLite cache DB is not writable: ' . $path);
        }

        $pdo = new \PDO('sqlite:' . $path);
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('PRAGMA journal_mode=WAL;');
        $pdo->exec('PRAGMA synchronous=NORMAL;');
        $pdo->exec('PRAGMA foreign_keys=ON;');
        @chmod($path, 0664);
        return $pdo;
    }

    protected function cacheMigrate(\PDO $pdo): void
    {
        $pdo->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)');

        // Fast-path: if schema is current, skip the expensive introspection work.
        try {
            $cur = $this->cacheMetaGet($pdo, null, 'schema_version');
            if ($cur === self::CACHE_SCHEMA_VERSION) {
                // Even when schema_version claims "current", older DBs might still be missing
                // newly-added columns (or schema_version may have been set manually).
                // These checks are cheap and prevent runtime 500s.
                $this->cacheEnsureColumn($pdo, 'profiles', 'avatar', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'posts', 'text', 'TEXT');

                // New tables added over time should still be ensured here.
                $pdo->exec('CREATE TABLE IF NOT EXISTS follow_queue (
                    actor_did TEXT NOT NULL,
                    target_did TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT "pending",
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    follow_uri TEXT,
                    next_attempt_at TEXT,
                    created_at TEXT,
                    updated_at TEXT,
                    PRIMARY KEY(actor_did, target_did)
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_follow_queue_actor_state ON follow_queue(actor_did, state)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_follow_queue_next_attempt ON follow_queue(actor_did, next_attempt_at)');

                // Site-local groups (Facebook Groups parity).
                $pdo->exec('CREATE TABLE IF NOT EXISTS groups (
                    group_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    visibility TEXT NOT NULL DEFAULT "public",
                    owner_did TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )');
                $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug ON groups(slug)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_did)');
                $this->cacheEnsureColumn($pdo, 'groups', 'rules_md', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'groups', 'rules_updated_at', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'groups', 'post_cooldown_seconds', 'INTEGER');

                $pdo->exec('CREATE TABLE IF NOT EXISTS group_members (
                    group_id INTEGER NOT NULL,
                    member_did TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT "member",
                    role TEXT NOT NULL DEFAULT "member",
                    joined_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(group_id, member_did)
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_members_group_state ON group_members(group_id, state)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_did)');
                $this->cacheEnsureColumn($pdo, 'group_members', 'rules_accepted_at', 'TEXT');

                // Group-local enforcement (warn/suspend/ban).
                $this->cacheEnsureColumn($pdo, 'group_members', 'warn_count', 'INTEGER');
                $this->cacheEnsureColumn($pdo, 'group_members', 'last_warned_at', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'group_members', 'last_warn_note', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'group_members', 'suspended_until', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'group_members', 'suspend_note', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'group_members', 'banned_at', 'TEXT');
                $this->cacheEnsureColumn($pdo, 'group_members', 'ban_note', 'TEXT');

                $pdo->exec('CREATE TABLE IF NOT EXISTS group_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id INTEGER NOT NULL,
                    actor_did TEXT NOT NULL,
                    action TEXT NOT NULL,
                    subject TEXT,
                    detail TEXT,
                    created_at TEXT NOT NULL
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_audit_group_created ON group_audit(group_id, created_at)');

                $pdo->exec('CREATE TABLE IF NOT EXISTS group_invites (
                    invite_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id INTEGER NOT NULL,
                    token_hash TEXT NOT NULL,
                    token_hint TEXT,
                    created_by_did TEXT,
                    created_at TEXT NOT NULL,
                    expires_at TEXT,
                    revoked_at TEXT
                )');
                $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_group_invites_group_hash ON group_invites(group_id, token_hash)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_invites_group_revoked ON group_invites(group_id, revoked_at)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_invites_hash ON group_invites(token_hash)');

                // Group-scoped post moderation (approved feed + pending queue).
                $pdo->exec('CREATE TABLE IF NOT EXISTS group_posts (
                    post_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id INTEGER NOT NULL,
                    author_did TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT "pending",
                    text TEXT NOT NULL,
                    langs TEXT,
                    facets TEXT,
                    embed TEXT,
                    created_post_uri TEXT,
                    created_post_cid TEXT,
                    created_at TEXT NOT NULL,
                    decided_at TEXT,
                    decided_by_did TEXT,
                    decision_note TEXT
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_posts_group_state_created ON group_posts(group_id, state, post_id DESC)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_posts_group_created ON group_posts(group_id, post_id DESC)');
                $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_group_posts_uri ON group_posts(created_post_uri)');

                // Group post hiding (site-local suppression of public tag feed).
                $pdo->exec('CREATE TABLE IF NOT EXISTS group_post_hidden (
                    group_id INTEGER NOT NULL,
                    post_uri TEXT NOT NULL,
                    hidden_by_did TEXT NOT NULL,
                    hidden_at TEXT NOT NULL,
                    note TEXT,
                    PRIMARY KEY(group_id, post_uri)
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_post_hidden_group ON group_post_hidden(group_id, hidden_at)');

                // Group pinned posts / announcements (site-local).
                $pdo->exec('CREATE TABLE IF NOT EXISTS group_pins (
                    group_id INTEGER NOT NULL,
                    post_uri TEXT NOT NULL,
                    pinned_by_did TEXT NOT NULL,
                    pinned_at TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    is_announcement INTEGER NOT NULL DEFAULT 0,
                    note TEXT,
                    PRIMARY KEY(group_id, post_uri)
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_pins_group_time ON group_pins(group_id, pinned_at DESC)');
                $this->cacheEnsureColumn($pdo, 'group_pins', 'sort_order', 'INTEGER');
                $this->cacheBackfillGroupPinsSortOrder($pdo);

                // Group phrase filters (keyword/phrase moderation).
                $pdo->exec('CREATE TABLE IF NOT EXISTS group_phrase_filters (
                    group_id INTEGER NOT NULL,
                    phrase TEXT NOT NULL,
                    action TEXT NOT NULL DEFAULT "require_approval",
                    created_by_did TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(group_id, phrase)
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_phrase_filters_group ON group_phrase_filters(group_id)');

                // Group report queue (member reports against public posts/URIs).
                $pdo->exec('CREATE TABLE IF NOT EXISTS group_reports (
                    report_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id INTEGER NOT NULL,
                    post_uri TEXT NOT NULL,
                    reporter_did TEXT NOT NULL,
                    reason TEXT,
                    state TEXT NOT NULL DEFAULT "open",
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    resolved_by_did TEXT,
                    resolution_note TEXT
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_reports_group_state ON group_reports(group_id, state, report_id DESC)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_reports_post ON group_reports(group_id, post_uri)');

                // OAuth background refresh requires client_id to be persisted.
                $this->cacheEnsureColumn($pdo, 'auth_sessions', 'client_id', 'TEXT');

                // Scheduled posts queue (durable; published by a background job).
                $pdo->exec('CREATE TABLE IF NOT EXISTS scheduled_posts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    actor_did TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT "pending",
                    kind TEXT NOT NULL DEFAULT "post",
                    scheduled_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    next_attempt_at TEXT,
                    result_uri TEXT,
                    result_cid TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_scheduled_posts_actor_state_time ON scheduled_posts(actor_did, state, scheduled_at)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_scheduled_posts_actor_next_attempt ON scheduled_posts(actor_did, next_attempt_at)');
                return;
            }
        } catch (\Throwable $e) {
            // ignore; fall through to full migrate
        }

        // Concrete user ↔ Bluesky sessions (server-side only).
        // v2 supports multiple accounts per Concrete user; active account is tracked via meta key c5_user:<id>:active_did.
        $needsAuthV2 = false;
        try {
            $cols = $pdo->query('PRAGMA table_info(auth_sessions)')->fetchAll(\PDO::FETCH_ASSOC) ?: [];
            if ($cols) {
                $pkCols = [];
                foreach ($cols as $c) {
                    if (!empty($c['pk']) && !empty($c['name'])) $pkCols[] = (string)$c['name'];
                }
                // v1: PRIMARY KEY(c5_user_id)
                if ($pkCols === ['c5_user_id']) {
                    $needsAuthV2 = true;
                }
            }
        } catch (\Throwable $e) {
            $needsAuthV2 = false;
        }

        if ($needsAuthV2) {
            try { $pdo->exec('ALTER TABLE auth_sessions RENAME TO auth_sessions_v1'); } catch (\Throwable $e) { /* ignore */ }
        }

        $pdo->exec('CREATE TABLE IF NOT EXISTS auth_sessions (
            c5_user_id INTEGER NOT NULL,
            did TEXT NOT NULL,
            handle TEXT,
            pds TEXT,
            client_id TEXT,
            access_jwt TEXT NOT NULL,
            refresh_jwt TEXT NOT NULL,
            auth_type TEXT,
            auth_issuer TEXT,
            dpop_private_pem TEXT,
            dpop_public_jwk TEXT,
            auth_dpop_nonce TEXT,
            resource_dpop_nonce TEXT,
            token_expires_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            PRIMARY KEY(c5_user_id, did)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(c5_user_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_auth_sessions_did ON auth_sessions(did)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_auth_sessions_updated ON auth_sessions(c5_user_id, updated_at)');

        if ($needsAuthV2) {
            try {
                $pdo->exec('INSERT OR IGNORE INTO auth_sessions(c5_user_id,did,handle,pds,client_id,access_jwt,refresh_jwt,auth_type,auth_issuer,dpop_private_pem,dpop_public_jwk,auth_dpop_nonce,resource_dpop_nonce,token_expires_at,created_at,updated_at)
                    SELECT c5_user_id,did,handle,pds,NULL,access_jwt,refresh_jwt,auth_type,auth_issuer,dpop_private_pem,dpop_public_jwk,auth_dpop_nonce,resource_dpop_nonce,token_expires_at,created_at,updated_at FROM auth_sessions_v1');
            } catch (\Throwable $e) {
                // ignore
            }
        }

        // List of Bluesky accounts (DIDs) ever connected by each Concrete user.
        // History is stored per DID in other tables (e.g. posts/notifications).
        $pdo->exec('CREATE TABLE IF NOT EXISTS c5_accounts (
            c5_user_id INTEGER NOT NULL,
            did TEXT NOT NULL,
            handle TEXT,
            pds TEXT,
            account_created_at TEXT,
            first_connected_at TEXT,
            last_connected_at TEXT,
            PRIMARY KEY(c5_user_id, did)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_c5_accounts_user ON c5_accounts(c5_user_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_c5_accounts_did ON c5_accounts(did)');

        // If upgrading an existing DB, ensure new account-related columns exist.
        $this->cacheEnsureColumn($pdo, 'c5_accounts', 'account_created_at', 'TEXT');

        // If upgrading an existing DB, ensure new OAuth-related columns exist.
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'auth_type', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'auth_issuer', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'dpop_private_pem', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'dpop_public_jwk', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'auth_dpop_nonce', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'resource_dpop_nonce', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'token_expires_at', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'client_id', 'TEXT');

        // Temporary OAuth state for authorization code flow.
        $pdo->exec('CREATE TABLE IF NOT EXISTS oauth_states (
            state TEXT PRIMARY KEY,
            c5_user_id INTEGER NOT NULL,
            issuer TEXT NOT NULL,
            code_verifier TEXT NOT NULL,
            dpop_private_pem TEXT NOT NULL,
            dpop_public_jwk TEXT NOT NULL,
            login_hint TEXT,
            created_at TEXT NOT NULL
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_oauth_states_user ON oauth_states(c5_user_id)');

        $pdo->exec('CREATE TABLE IF NOT EXISTS profiles (
            did TEXT PRIMARY KEY,
            handle TEXT,
            avatar TEXT,
            display_name TEXT,
            description TEXT,
            created_at TEXT,
            followers_count INTEGER,
            follows_count INTEGER,
            posts_count INTEGER,
            raw_json TEXT,
            updated_at TEXT
        )');

        // If upgrading an existing DB, ensure the avatar column exists.
        $this->cacheEnsureColumn($pdo, 'profiles', 'avatar', 'TEXT');

        // Manual-maintained FTS table; keep did unindexed but stored
        $pdo->exec('CREATE VIRTUAL TABLE IF NOT EXISTS profiles_fts USING fts5(
            did UNINDEXED,
            handle,
            avatar UNINDEXED,
            display_name,
            description
        )');

        // Upgrade older FTS schema (virtual tables can't be ALTERed reliably across builds).
        try {
            $cols = $pdo->query('PRAGMA table_info(profiles_fts)')->fetchAll(\PDO::FETCH_ASSOC) ?: [];
            $have = [];
            foreach ($cols as $c) {
                if (!empty($c['name'])) $have[$c['name']] = true;
            }
            if (empty($have['avatar'])) {
                $pdo->exec('DROP TABLE IF EXISTS profiles_fts');
                $pdo->exec('CREATE VIRTUAL TABLE profiles_fts USING fts5(did UNINDEXED, handle, avatar UNINDEXED, display_name, description)');
                $pdo->exec('INSERT INTO profiles_fts(did,handle,avatar,display_name,description) SELECT did,handle,avatar,display_name,description FROM profiles');
            }
        } catch (\Throwable $e) {
            // ignore; worst case is reduced search capability until next sync
        }

        $pdo->exec('CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_did TEXT NOT NULL,
            kind TEXT NOT NULL,
            taken_at TEXT NOT NULL
        )');

        $pdo->exec('CREATE TABLE IF NOT EXISTS edges (
            snapshot_id INTEGER NOT NULL,
            actor_did TEXT NOT NULL,
            other_did TEXT NOT NULL,
            kind TEXT NOT NULL,
            PRIMARY KEY(snapshot_id, other_did),
            FOREIGN KEY(snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
        )');

        // Helps cacheQueryPeople() which filters edges by snapshot_id + kind.
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_edges_snapshot_kind_other ON edges(snapshot_id, kind, other_did)');

        // Persisted follow queue (rate-limit friendly bulk follow support).
        $pdo->exec('CREATE TABLE IF NOT EXISTS follow_queue (
            actor_did TEXT NOT NULL,
            target_did TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT "pending",
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            follow_uri TEXT,
            next_attempt_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            PRIMARY KEY(actor_did, target_did)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_follow_queue_actor_state ON follow_queue(actor_did, state)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_follow_queue_next_attempt ON follow_queue(actor_did, next_attempt_at)');

        // Per-snapshot profile metrics to compute deltas later.
        $pdo->exec('CREATE TABLE IF NOT EXISTS profile_snapshots (
            snapshot_id INTEGER NOT NULL,
            did TEXT NOT NULL,
            handle TEXT,
            avatar TEXT,
            display_name TEXT,
            description TEXT,
            created_at TEXT,
            followers_count INTEGER,
            follows_count INTEGER,
            posts_count INTEGER,
            PRIMARY KEY(snapshot_id, did),
            FOREIGN KEY(snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
        )');

        // Cached notifications (local browsing + stats).
        // Multi-tenant: notifications are per actor DID.
        $needsNotifV2 = false;
        try {
            $cols = $pdo->query('PRAGMA table_info(notifications)')->fetchAll(\PDO::FETCH_ASSOC) ?: [];
            if ($cols) {
                $have = [];
                foreach ($cols as $c) {
                    if (!empty($c['name'])) $have[$c['name']] = true;
                }
                // v1 schema had: id,indexed_at,reason,author_did,reason_subject,raw_json,updated_at
                if (empty($have['actor_did']) || empty($have['notif_id'])) {
                    $needsNotifV2 = true;
                }
            }
        } catch (\Throwable $e) {
            $needsNotifV2 = false;
        }

        if ($needsNotifV2) {
            try {
                // Keep old data around (we'll import it as legacy).
                $pdo->exec('ALTER TABLE notifications RENAME TO notifications_v1');
            } catch (\Throwable $e) {
                // ignore
            }
        }

        $pdo->exec('CREATE TABLE IF NOT EXISTS notifications (
            actor_did TEXT NOT NULL,
            notif_id TEXT NOT NULL,
            indexed_at TEXT,
            reason TEXT,
            author_did TEXT,
            reason_subject TEXT,
            raw_json TEXT,
            updated_at TEXT,
            PRIMARY KEY(actor_did, notif_id)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_notifications_actor_time ON notifications(actor_did, indexed_at)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_notifications_author ON notifications(author_did)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_notifications_reason ON notifications(reason)');

        if ($needsNotifV2) {
            try {
                $pdo->exec('INSERT OR IGNORE INTO notifications(actor_did, notif_id, indexed_at, reason, author_did, reason_subject, raw_json, updated_at)
                    SELECT "__legacy__", id, indexed_at, reason, author_did, reason_subject, raw_json, updated_at FROM notifications_v1');
            } catch (\Throwable $e) {
                // ignore
            }
        }

        // Cached author feed items (My Posts) per actor DID.
        $pdo->exec('CREATE TABLE IF NOT EXISTS posts (
            actor_did TEXT NOT NULL,
            uri TEXT NOT NULL,
            cid TEXT,
            kind TEXT,
            text TEXT,
            created_at TEXT,
            indexed_at TEXT,
            raw_json TEXT,
            updated_at TEXT,
            PRIMARY KEY(actor_did, uri)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_posts_actor_created ON posts(actor_did, created_at)');

        // If upgrading an existing DB, ensure the text column exists.
        $this->cacheEnsureColumn($pdo, 'posts', 'text', 'TEXT');

        // Optional FTS index for cached post text.
        // If FTS5 isn't compiled into SQLite, these will fail and we fall back to LIKE.
        try {
            $pdo->exec('CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(text, content="posts", content_rowid="rowid")');

            // Triggers to keep posts_fts in sync with posts.text.
            $pdo->exec('CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
                INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
            END');
            $pdo->exec('CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
                INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ("delete", old.rowid, old.text);
            END');
            $pdo->exec('CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
                INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ("delete", old.rowid, old.text);
                INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
            END');
        } catch (\Throwable $e) {
            // ignore; LIKE fallback will still work using posts.text/raw_json.
        }

        // Scheduled posts queue (durable; published by a background job).
        $pdo->exec('CREATE TABLE IF NOT EXISTS scheduled_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_did TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT "pending",
            kind TEXT NOT NULL DEFAULT "post",
            scheduled_at TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            next_attempt_at TEXT,
            result_uri TEXT,
            result_cid TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_scheduled_posts_actor_state_time ON scheduled_posts(actor_did, state, scheduled_at)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_scheduled_posts_actor_next_attempt ON scheduled_posts(actor_did, next_attempt_at)');

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_snapshots_actor_kind ON snapshots(actor_did, kind, taken_at)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_edges_actor_kind ON edges(actor_did, kind)');

        // People monitoring (watchlist) per owner DID.
        $pdo->exec('CREATE TABLE IF NOT EXISTS watchlist (
            owner_did TEXT NOT NULL,
            watched_did TEXT NOT NULL,
            watched_handle TEXT,
            created_at TEXT,
            updated_at TEXT,
            last_checked_at TEXT,
            last_seen_post_created_at TEXT,
            last_seen_post_uri TEXT,
            PRIMARY KEY(owner_did, watched_did)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_watchlist_owner ON watchlist(owner_did)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_watchlist_watched ON watchlist(watched_did)');

        $pdo->exec('CREATE TABLE IF NOT EXISTS watch_events (
            owner_did TEXT NOT NULL,
            watched_did TEXT NOT NULL,
            post_uri TEXT NOT NULL,
            post_created_at TEXT,
            detected_at TEXT NOT NULL,
            raw_json TEXT,
            PRIMARY KEY(owner_did, watched_did, post_uri)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_watch_events_owner_detected ON watch_events(owner_did, detected_at)');

        // Site-local groups (Facebook Groups parity).
        $pdo->exec('CREATE TABLE IF NOT EXISTS groups (
            group_id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            visibility TEXT NOT NULL DEFAULT "public",
            owner_did TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )');
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug ON groups(slug)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_did)');
        $this->cacheEnsureColumn($pdo, 'groups', 'rules_md', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'groups', 'rules_updated_at', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'groups', 'post_cooldown_seconds', 'INTEGER');

        $pdo->exec('CREATE TABLE IF NOT EXISTS group_members (
            group_id INTEGER NOT NULL,
            member_did TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT "member",
            role TEXT NOT NULL DEFAULT "member",
            joined_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(group_id, member_did)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_members_group_state ON group_members(group_id, state)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_did)');
        $this->cacheEnsureColumn($pdo, 'group_members', 'rules_accepted_at', 'TEXT');

        // Group-local enforcement (warn/suspend/ban).
        $this->cacheEnsureColumn($pdo, 'group_members', 'warn_count', 'INTEGER');
        $this->cacheEnsureColumn($pdo, 'group_members', 'last_warned_at', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'group_members', 'last_warn_note', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'group_members', 'suspended_until', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'group_members', 'suspend_note', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'group_members', 'banned_at', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'group_members', 'ban_note', 'TEXT');

        $pdo->exec('CREATE TABLE IF NOT EXISTS group_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            actor_did TEXT NOT NULL,
            action TEXT NOT NULL,
            subject TEXT,
            detail TEXT,
            created_at TEXT NOT NULL
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_audit_group_created ON group_audit(group_id, created_at)');

        $pdo->exec('CREATE TABLE IF NOT EXISTS group_invites (
            invite_id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            token_hint TEXT,
            created_by_did TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            revoked_at TEXT
        )');
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_group_invites_group_hash ON group_invites(group_id, token_hash)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_invites_group_revoked ON group_invites(group_id, revoked_at)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_invites_hash ON group_invites(token_hash)');

        // Group-scoped post moderation (approved feed + pending queue).
        $pdo->exec('CREATE TABLE IF NOT EXISTS group_posts (
            post_id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            author_did TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT "pending",
            text TEXT NOT NULL,
            langs TEXT,
            facets TEXT,
            embed TEXT,
            created_post_uri TEXT,
            created_post_cid TEXT,
            created_at TEXT NOT NULL,
            decided_at TEXT,
            decided_by_did TEXT,
            decision_note TEXT
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_posts_group_state_created ON group_posts(group_id, state, post_id DESC)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_posts_group_created ON group_posts(group_id, post_id DESC)');
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_group_posts_uri ON group_posts(created_post_uri)');

        // Group post hiding (site-local suppression of public tag feed).
        $pdo->exec('CREATE TABLE IF NOT EXISTS group_post_hidden (
            group_id INTEGER NOT NULL,
            post_uri TEXT NOT NULL,
            hidden_by_did TEXT NOT NULL,
            hidden_at TEXT NOT NULL,
            note TEXT,
            PRIMARY KEY(group_id, post_uri)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_post_hidden_group ON group_post_hidden(group_id, hidden_at)');

        // Group pinned posts / announcements (site-local).
        $pdo->exec('CREATE TABLE IF NOT EXISTS group_pins (
            group_id INTEGER NOT NULL,
            post_uri TEXT NOT NULL,
            pinned_by_did TEXT NOT NULL,
            pinned_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_announcement INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            PRIMARY KEY(group_id, post_uri)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_pins_group_time ON group_pins(group_id, pinned_at DESC)');
        $this->cacheEnsureColumn($pdo, 'group_pins', 'sort_order', 'INTEGER');
        $this->cacheBackfillGroupPinsSortOrder($pdo);

        // Group phrase filters (keyword/phrase moderation).
        $pdo->exec('CREATE TABLE IF NOT EXISTS group_phrase_filters (
            group_id INTEGER NOT NULL,
            phrase TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT "require_approval",
            created_by_did TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(group_id, phrase)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_phrase_filters_group ON group_phrase_filters(group_id)');

        // Group report queue (member reports against public posts/URIs).
        $pdo->exec('CREATE TABLE IF NOT EXISTS group_reports (
            report_id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            post_uri TEXT NOT NULL,
            reporter_did TEXT NOT NULL,
            reason TEXT,
            state TEXT NOT NULL DEFAULT "open",
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            resolved_by_did TEXT,
            resolution_note TEXT
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_reports_group_state ON group_reports(group_id, state, report_id DESC)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_group_reports_post ON group_reports(group_id, post_uri)');

        // Mark schema current.
        $this->cacheMetaSet($pdo, null, 'schema_version', self::CACHE_SCHEMA_VERSION);
    }

    protected function cacheAccountsUpsert(\PDO $pdo, int $c5UserId, string $did, ?string $handle, ?string $pds, ?string $accountCreatedAt = null): void
    {
        $now = gmdate('c');
        $st = $pdo->prepare('INSERT INTO c5_accounts(c5_user_id, did, handle, pds, account_created_at, first_connected_at, last_connected_at)
            VALUES(:u,:did,:h,:pds,:ca,:t,:t)
            ON CONFLICT(c5_user_id, did) DO UPDATE SET
              handle=excluded.handle,
              pds=excluded.pds,
              account_created_at=COALESCE(excluded.account_created_at, c5_accounts.account_created_at),
              last_connected_at=excluded.last_connected_at');
        $st->execute([
            ':u' => $c5UserId,
            ':did' => $did,
            ':h' => $handle,
            ':pds' => $pds,
            ':ca' => $accountCreatedAt,
            ':t' => $now,
        ]);
    }

    protected function cacheMetaKey(?string $actorDid, string $key): string
    {
        $actorDid = $actorDid ?: '__global__';
        return $actorDid . ':' . $key;
    }

    protected function cacheMetaGet(\PDO $pdo, ?string $actorDid, string $key): ?string
    {
        $key = $this->cacheMetaKey($actorDid, $key);
        $st = $pdo->prepare('SELECT v FROM meta WHERE k = :k');
        $st->execute([':k' => $key]);
        $v = $st->fetchColumn();
        return $v !== false ? (string)$v : null;
    }

    protected function cacheMetaSet(\PDO $pdo, ?string $actorDid, string $key, string $val): void
    {
        $key = $this->cacheMetaKey($actorDid, $key);
        $st = $pdo->prepare('INSERT INTO meta(k,v,updated_at) VALUES(:k,:v,:t)
            ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at');
        $st->execute([':k' => $key, ':v' => $val, ':t' => gmdate('c')]);
    }

    protected function cacheUpsertProfile(\PDO $pdo, array $p): void
    {
        $did = (string)($p['did'] ?? '');
        if ($did === '') return;

        $row = [
            ':did' => $did,
            ':handle' => isset($p['handle']) ? (string)$p['handle'] : null,
            ':avatar' => isset($p['avatar']) ? (string)$p['avatar'] : null,
            ':display_name' => isset($p['displayName']) ? (string)$p['displayName'] : null,
            ':description' => isset($p['description']) ? (string)$p['description'] : null,
            ':created_at' => isset($p['createdAt']) ? (string)$p['createdAt'] : null,
            ':followers_count' => isset($p['followersCount']) ? (int)$p['followersCount'] : null,
            ':follows_count' => isset($p['followsCount']) ? (int)$p['followsCount'] : null,
            ':posts_count' => isset($p['postsCount']) ? (int)$p['postsCount'] : null,
            ':raw_json' => json_encode($p),
            ':updated_at' => gmdate('c'),
        ];

        $st = $pdo->prepare('INSERT INTO profiles(did,handle,avatar,display_name,description,created_at,followers_count,follows_count,posts_count,raw_json,updated_at)
            VALUES(:did,:handle,:avatar,:display_name,:description,:created_at,:followers_count,:follows_count,:posts_count,:raw_json,:updated_at)
            ON CONFLICT(did) DO UPDATE SET
              handle=excluded.handle,
              avatar=excluded.avatar,
              display_name=excluded.display_name,
              description=excluded.description,
              created_at=COALESCE(excluded.created_at, profiles.created_at),
              followers_count=excluded.followers_count,
              follows_count=excluded.follows_count,
              posts_count=excluded.posts_count,
              raw_json=excluded.raw_json,
              updated_at=excluded.updated_at');
        $st->execute($row);

        // Update FTS row (replace)
        $st2 = $pdo->prepare('DELETE FROM profiles_fts WHERE did = :did');
        $st2->execute([':did' => $did]);
        $st3 = $pdo->prepare('INSERT INTO profiles_fts(did,handle,avatar,display_name,description) VALUES(:did,:handle,:avatar,:display_name,:description)');
        $st3->execute([
            ':did' => $did,
            ':handle' => $row[':handle'],
            ':avatar' => $row[':avatar'],
            ':display_name' => $row[':display_name'],
            ':description' => $row[':description'],
        ]);
    }

    protected function cacheSyncList(\PDO $pdo, array &$session, string $actorDid, string $kind, int $pagesMax): array
    {
        $takenAt = gmdate('c');
        $stSnap = $pdo->prepare('INSERT INTO snapshots(actor_did, kind, taken_at) VALUES(:a,:k,:t)');
        $stSnap->execute([':a' => $actorDid, ':k' => $kind, ':t' => $takenAt]);
        $snapshotId = (int)$pdo->lastInsertId();

        $cursor = null;
        $count = 0;
        $page = 0;
        $pagesProcessed = 0;

        $stEdge = $pdo->prepare('INSERT OR IGNORE INTO edges(snapshot_id, actor_did, other_did, kind) VALUES(:sid,:a,:o,:k)');
        $stProfSnap = $pdo->prepare('INSERT OR REPLACE INTO profile_snapshots(snapshot_id,did,handle,avatar,display_name,description,created_at,followers_count,follows_count,posts_count)
            VALUES(:sid,:did,:handle,:avatar,:display_name,:description,:created_at,:followers_count,:follows_count,:posts_count)');

        while ($page < $pagesMax) {
            if ($kind === 'followers') {
                $data = $this->xrpcSession('GET', 'app.bsky.graph.getFollowers', $session, [
                    'actor' => $actorDid,
                    'limit' => 100,
                    'cursor' => $cursor,
                ]);
                foreach (($data['followers'] ?? []) as $p) {
                    $this->cacheUpsertProfile($pdo, $p);
                    $did = $p['did'] ?? null;
                    if ($did) {
                        $stEdge->execute([':sid' => $snapshotId, ':a' => $actorDid, ':o' => $did, ':k' => $kind]);
                        $stProfSnap->execute([
                            ':sid' => $snapshotId,
                            ':did' => (string)$did,
                            ':handle' => isset($p['handle']) ? (string)$p['handle'] : null,
                            ':avatar' => isset($p['avatar']) ? (string)$p['avatar'] : null,
                            ':display_name' => isset($p['displayName']) ? (string)$p['displayName'] : null,
                            ':description' => isset($p['description']) ? (string)$p['description'] : null,
                            ':created_at' => isset($p['createdAt']) ? (string)$p['createdAt'] : null,
                            ':followers_count' => isset($p['followersCount']) ? (int)$p['followersCount'] : null,
                            ':follows_count' => isset($p['followsCount']) ? (int)$p['followsCount'] : null,
                            ':posts_count' => isset($p['postsCount']) ? (int)$p['postsCount'] : null,
                        ]);
                        $count++;
                    }
                }
                $cursor = $data['cursor'] ?? null;
            } else {
                $data = $this->xrpcSession('GET', 'app.bsky.graph.getFollows', $session, [
                    'actor' => $actorDid,
                    'limit' => 100,
                    'cursor' => $cursor,
                ]);
                foreach (($data['follows'] ?? []) as $p) {
                    $this->cacheUpsertProfile($pdo, $p);
                    $did = $p['did'] ?? null;
                    if ($did) {
                        $stEdge->execute([':sid' => $snapshotId, ':a' => $actorDid, ':o' => $did, ':k' => $kind]);
                        $stProfSnap->execute([
                            ':sid' => $snapshotId,
                            ':did' => (string)$did,
                            ':handle' => isset($p['handle']) ? (string)$p['handle'] : null,
                            ':avatar' => isset($p['avatar']) ? (string)$p['avatar'] : null,
                            ':display_name' => isset($p['displayName']) ? (string)$p['displayName'] : null,
                            ':description' => isset($p['description']) ? (string)$p['description'] : null,
                            ':created_at' => isset($p['createdAt']) ? (string)$p['createdAt'] : null,
                            ':followers_count' => isset($p['followersCount']) ? (int)$p['followersCount'] : null,
                            ':follows_count' => isset($p['followsCount']) ? (int)$p['followsCount'] : null,
                            ':posts_count' => isset($p['postsCount']) ? (int)$p['postsCount'] : null,
                        ]);
                        $count++;
                    }
                }
                $cursor = $data['cursor'] ?? null;
            }

            if (!$cursor) break;
            $page++;
        }

        $this->cacheMetaSet($pdo, $actorDid, "last_snapshot_{$kind}", (string)$snapshotId);

        return [
            'snapshotId' => $snapshotId,
            'takenAt' => $takenAt,
            'count' => $count,
            'pages' => $page + 1,
            'truncated' => (bool)$cursor,
        ];
    }

    protected function cacheSyncNotifications(\PDO $pdo, array &$session, string $actorDid, int $hours, int $pagesMax, ?string $stopBeforeIso = null): array
    {
        $cutoffTs = time() - ($hours * 3600);

        // Optional hard cutoff: stop once we hit notifications older than stopBefore.
        // We use the earlier (older) of the two cutoffs so stopBefore can extend beyond the hours window.
        if ($stopBeforeIso) {
            $stopTs = strtotime($stopBeforeIso);
            if ($stopTs !== false) {
                $cutoffTs = min($cutoffTs, (int)$stopTs);
            }
        }

        // Incremental stop: once we reach the last-seen timestamp, we can stop paging.
        // This makes periodic sync (every minute) cheap.
        $useIncrementalStop = ($hours <= 48);
        $lastSeenIso = $useIncrementalStop ? $this->cacheMetaGet($pdo, $actorDid, 'last_notifications_seen_at') : null;
        $lastSeenTs = $lastSeenIso ? strtotime($lastSeenIso) : null;
        if ($useIncrementalStop && $lastSeenTs && $lastSeenTs > $cutoffTs) $cutoffTs = $lastSeenTs;

        // Cursor usage differs by mode:
        // - incremental: always start at newest (cursor=null)
        // - backfill: resume from a stored cursor if present
        $cursor = null;
        if (!$useIncrementalStop) {
            $storedCursor = $this->cacheMetaGet($pdo, $actorDid, 'notifications_backfill_cursor');
            if ($storedCursor) $cursor = $storedCursor;
        }

        $count = 0;
        $inserted = 0;
        $updated = 0;
        $skipped = 0;
        $page = 0;
        $pagesProcessed = 0;
        $stoppedEarly = false;
        $maxSeenTs = null;
        $minSeenTs = null;

        // We want insert vs update counts for better UX/progress.
        // SQLite upsert doesn't directly expose which path happened, so we do an INSERT-OR-IGNORE
        // followed by UPDATE only when needed. Conflicts should be rare for backfill.
        $stInsert = $pdo->prepare('INSERT INTO notifications(actor_did, notif_id, indexed_at, reason, author_did, reason_subject, raw_json, updated_at)
            VALUES(:a,:id,:ts,:reason,:author,:subject,:raw,:u)
            ON CONFLICT(actor_did, notif_id) DO NOTHING');

        $stUpdate = $pdo->prepare('UPDATE notifications SET
                indexed_at=:ts,
                reason=:reason,
                author_did=:author,
                reason_subject=:subject,
                raw_json=:raw,
                updated_at=:u
            WHERE actor_did=:a AND notif_id=:id');

        while ($page < $pagesMax) {
            $data = $this->xrpcSession('GET', 'app.bsky.notification.listNotifications', $session, [
                'limit' => 100,
                'cursor' => $cursor,
            ]);

            $batch = $data['notifications'] ?? [];
            if (!$batch) break;

            $pagesProcessed++;

            foreach ($batch as $n) {
                $ts = $n['indexedAt'] ?? $n['createdAt'] ?? null;
                if ($ts) {
                    try {
                        $dt = new \DateTimeImmutable($ts);
                        $t = $dt->getTimestamp();
                        if ($maxSeenTs === null || $t > $maxSeenTs) $maxSeenTs = $t;
                        if ($minSeenTs === null || $t < $minSeenTs) $minSeenTs = $t;

                        // Stop once we hit notifications older than our cutoff.
                        if ($t <= $cutoffTs) {
                            $stoppedEarly = true;
                            $cursor = null;
                            break 2;
                        }
                    } catch (\Throwable $e) { /* ignore */ }
                }

                $author = $n['author'] ?? [];
                if (is_array($author) && !empty($author['did'])) {
                    $this->cacheUpsertProfile($pdo, $author);
                }

                $notifId = (string)($n['uri'] ?? '');
                if ($notifId === '') {
                    $notifId = sha1(json_encode([
                        $n['reason'] ?? '',
                        $n['indexedAt'] ?? '',
                        $author['did'] ?? '',
                        $n['reasonSubject'] ?? '',
                    ]));
                }

                if ($notifId === '') {
                    $skipped++;
                    continue;
                }

                $bind = [
                    ':a' => $actorDid,
                    ':id' => $notifId,
                    ':ts' => $ts,
                    ':reason' => isset($n['reason']) ? (string)$n['reason'] : null,
                    ':author' => isset($author['did']) ? (string)$author['did'] : null,
                    ':subject' => isset($n['reasonSubject']) ? (string)$n['reasonSubject'] : null,
                    ':raw' => json_encode($n),
                    ':u' => gmdate('c'),
                ];

                $stInsert->execute($bind);
                if ($stInsert->rowCount() === 1) {
                    $inserted++;
                } else {
                    $stUpdate->execute($bind);
                    $updated++;
                }
                $count++;
            }

            $cursor = $data['cursor'] ?? null;
            if (!$cursor) break;
            $page++;
        }

        // Backfill bookkeeping: if we're doing a deep window scan, persist cursor so next run can continue.
        if (!$useIncrementalStop) {
            if ($cursor) {
                $this->cacheMetaSet($pdo, $actorDid, 'notifications_backfill_cursor', (string)$cursor);
            } else {
                // Clear when fully drained or cutoff reached.
                $this->cacheMetaSet($pdo, $actorDid, 'notifications_backfill_cursor', '');
            }
        }

        if ($maxSeenTs !== null) {
            $prev = $lastSeenTs ?: 0;
            if ($maxSeenTs > $prev) {
                $this->cacheMetaSet($pdo, $actorDid, 'last_notifications_seen_at', gmdate('c', $maxSeenTs));
            }
        }

        $retentionLimited = false;
        if (!$cursor && !$stoppedEarly && $minSeenTs !== null && $minSeenTs > $cutoffTs) {
            // We ran out of API history before reaching our cutoff.
            // This likely indicates server-side retention limits.
            $retentionLimited = true;
        }

        $done = !$cursor;
        return [
            'hours' => $hours,
            'count' => $count,
            'pages' => $pagesProcessed,
            'truncated' => (bool)$cursor,
            'stoppedEarly' => $stoppedEarly,
            'done' => $done,
            'retentionLimited' => $retentionLimited,
            'oldestSeenIso' => $minSeenTs !== null ? gmdate('c', $minSeenTs) : null,
            'inserted' => $inserted,
            'updated' => $updated,
            'skipped' => $skipped,
            'cutoffIso' => gmdate('c', $cutoffTs),
        ];
    }

    protected function cacheDiffLatestTwo(\PDO $pdo, string $actorDid, string $kind, int $limit = 200, bool $includeProfiles = false): array
    {
        $st = $pdo->prepare('SELECT id, taken_at FROM snapshots WHERE actor_did = :a AND kind = :k ORDER BY id DESC LIMIT 2');
        $st->execute([':a' => $actorDid, ':k' => $kind]);
        $rows = $st->fetchAll(\PDO::FETCH_ASSOC);
        if (count($rows) < 2) {
            return ['ok' => true, 'kind' => $kind, 'message' => 'Need at least two snapshots', 'added' => [], 'removed' => [], 'counts' => ['added' => 0, 'removed' => 0]];
        }
        $latest = (int)$rows[0]['id'];
        $prev = (int)$rows[1]['id'];

        $sqlAdded = 'SELECT e1.other_did FROM edges e1
            LEFT JOIN edges e0 ON e0.snapshot_id = :prev AND e0.other_did = e1.other_did
            WHERE e1.snapshot_id = :latest AND e0.other_did IS NULL
            LIMIT :lim';
        $sqlRemoved = 'SELECT e0.other_did FROM edges e0
            LEFT JOIN edges e1 ON e1.snapshot_id = :latest AND e1.other_did = e0.other_did
            WHERE e0.snapshot_id = :prev AND e1.other_did IS NULL
            LIMIT :lim';

        $added = $this->cacheFetchDidList($pdo, $sqlAdded, $latest, $prev, $limit);
        $removed = $this->cacheFetchDidList($pdo, $sqlRemoved, $latest, $prev, $limit);

        $countAdded = (int)$pdo->query(
            "SELECT COUNT(*) FROM edges e1 LEFT JOIN edges e0 ON e0.snapshot_id = {$prev} AND e0.other_did=e1.other_did WHERE e1.snapshot_id={$latest} AND e0.other_did IS NULL"
        )->fetchColumn();
        $countRemoved = (int)$pdo->query(
            "SELECT COUNT(*) FROM edges e0 LEFT JOIN edges e1 ON e1.snapshot_id = {$latest} AND e1.other_did=e0.other_did WHERE e0.snapshot_id={$prev} AND e1.other_did IS NULL"
        )->fetchColumn();

        $out = [
            'ok' => true,
            'kind' => $kind,
            'latest' => ['id' => $latest, 'takenAt' => $rows[0]['taken_at']],
            'previous' => ['id' => $prev, 'takenAt' => $rows[1]['taken_at']],
            'counts' => ['added' => $countAdded, 'removed' => $countRemoved],
            'added' => $added,
            'removed' => $removed,
        ];

        if ($includeProfiles) {
            $out['addedProfiles'] = $this->cacheLoadProfiles($pdo, $added);
            $out['removedProfiles'] = $this->cacheLoadProfiles($pdo, $removed);
        }

        return $out;
    }

    protected function cacheFetchDidList(\PDO $pdo, string $sql, int $latest, int $prev, int $limit): array
    {
        $st = $pdo->prepare($sql);
        $st->bindValue(':latest', $latest, \PDO::PARAM_INT);
        $st->bindValue(':prev', $prev, \PDO::PARAM_INT);
        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
        $st->execute();
        return array_values(array_filter(array_map('strval', $st->fetchAll(\PDO::FETCH_COLUMN) ?: [])));
    }

    protected function cacheLoadProfiles(\PDO $pdo, array $dids): array
    {
        $dids = array_values(array_unique(array_filter(array_map('strval', $dids))));
        if (!$dids) return [];
        $in = implode(',', array_fill(0, count($dids), '?'));
        $st = $pdo->prepare("SELECT did, handle, avatar, display_name AS displayName, description, created_at AS createdAt, followers_count AS followersCount, follows_count AS followsCount, posts_count AS postsCount FROM profiles WHERE did IN ($in)");
        $st->execute($dids);
        return $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
    }

    protected function cacheQueryPeople(\PDO $pdo, string $actorDid, string $list, string $q, string $sort, bool $mutual, int $limit, int $offset): array
    {
        // Determine latest snapshot IDs
        $snapFollowers = $this->cacheMetaGet($pdo, $actorDid, 'last_snapshot_followers');
        $snapFollowing = $this->cacheMetaGet($pdo, $actorDid, 'last_snapshot_following');

        $snapFollowersId = $snapFollowers ? (int)$snapFollowers : null;
        $snapFollowingId = $snapFollowing ? (int)$snapFollowing : null;

        $where = [];
        $params = [];

        // Base selection set
        $join = '';
        if ($list === 'followers') {
            if (!$snapFollowersId) return ['ok' => true, 'items' => [], 'total' => 0, 'hasMore' => false, 'message' => 'No followers snapshot yet. Run cacheSync.'];
            $join = 'JOIN edges e ON e.other_did = p.did AND e.snapshot_id = :sid AND e.kind = "followers"';
            $params[':sid'] = $snapFollowersId;
        } elseif ($list === 'following') {
            if (!$snapFollowingId) return ['ok' => true, 'items' => [], 'total' => 0, 'hasMore' => false, 'message' => 'No following snapshot yet. Run cacheSync.'];
            $join = 'JOIN edges e ON e.other_did = p.did AND e.snapshot_id = :sid AND e.kind = "following"';
            $params[':sid'] = $snapFollowingId;
        } else {
            // all: union latest followers + following
            if (!$snapFollowersId && !$snapFollowingId) return ['ok' => true, 'items' => [], 'total' => 0, 'hasMore' => false, 'message' => 'No snapshots yet. Run cacheSync.'];
            $join = 'JOIN (SELECT other_did FROM edges WHERE snapshot_id = :sf AND kind = "followers" UNION SELECT other_did FROM edges WHERE snapshot_id = :sg AND kind = "following") u ON u.other_did = p.did';
            $params[':sf'] = $snapFollowersId ?: -1;
            $params[':sg'] = $snapFollowingId ?: -1;
        }

        // Mutual filter = in both latest snapshots
        if ($mutual) {
            if (!$snapFollowersId || !$snapFollowingId) {
                return ['ok' => true, 'items' => [], 'total' => 0, 'hasMore' => false, 'message' => 'Need both followers and following snapshots for mutuals. Run cacheSync(kind=both).'];
            }
            $where[] = 'EXISTS(SELECT 1 FROM edges f WHERE f.snapshot_id = :mf AND f.other_did = p.did AND f.kind = "followers")
                        AND EXISTS(SELECT 1 FROM edges g WHERE g.snapshot_id = :mg AND g.other_did = p.did AND g.kind = "following")';
            $params[':mf'] = $snapFollowersId;
            $params[':mg'] = $snapFollowingId;
        }

        // Search: try FTS for normal text; fallback to LIKE for emoji/anything.
        $q = trim($q);
        $useFts = ($q !== '' && preg_match('/[A-Za-z0-9_]/', $q));
        if ($q !== '') {
            if ($useFts) {
                // IMPORTANT: SQLite FTS MATCH expects the real virtual table name.
                // Using an alias here can trigger "unable to use function MATCH" / SQL errors on some builds.
                $join .= ' JOIN profiles_fts ON profiles_fts.did = p.did';
                $where[] = 'profiles_fts MATCH :q';
                $params[':q'] = $this->cacheFtsQuery($q);
            } else {
                $where[] = '(lower(p.handle) LIKE :like OR lower(p.display_name) LIKE :like OR lower(p.description) LIKE :like)';
                $params[':like'] = '%' . mb_strtolower($q) . '%';
            }
        }

        $order = [
            'followers' => 'COALESCE(p.followers_count,0) DESC',
            'following' => 'COALESCE(p.follows_count,0) DESC',
            'posts' => 'COALESCE(p.posts_count,0) DESC',
            'name' => 'COALESCE(p.display_name,p.handle,"") COLLATE NOCASE ASC',
            'handle' => 'COALESCE(p.handle,"") COLLATE NOCASE ASC',
            'age' => 'COALESCE(p.created_at,"") ASC',
        ][$sort] ?? 'COALESCE(p.followers_count,0) DESC';

        $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

        // Count total
        $stCount = $pdo->prepare("SELECT COUNT(*) FROM profiles p $join $whereSql");
        $stCount->execute($params);
        $total = (int)$stCount->fetchColumn();

        $sql = "SELECT p.did,
                       p.handle,
                  p.avatar,
                       p.display_name AS displayName,
                       p.description,
                       p.created_at AS createdAt,
                       p.followers_count AS followersCount,
                       p.follows_count AS followsCount,
                       p.posts_count AS postsCount
                FROM profiles p
                $join
                $whereSql
                ORDER BY $order
                LIMIT :lim OFFSET :off";

        $st = $pdo->prepare($sql);
        foreach ($params as $k => $v) $st->bindValue($k, $v);
        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
        $st->bindValue(':off', $offset, \PDO::PARAM_INT);
        $st->execute();
        $items = $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];

        return [
            'ok' => true,
            'items' => $items,
            'total' => $total,
            'hasMore' => ($offset + $limit) < $total,
            'snapshots' => ['followers' => $snapFollowersId, 'following' => $snapFollowingId],
        ];
    }

    protected function cacheQueryNotifications(\PDO $pdo, string $actorDid, ?string $sinceIso, ?string $untilIso, int $hours, array $reasons, int $limit, int $offset, bool $newestFirst): array
    {
        $cutoffIso = $hours > 0 ? gmdate('c', time() - ($hours * 3600)) : null;

        $where = ['n.actor_did = ?'];
        $params = [$actorDid];

        if ($sinceIso) {
            $where[] = 'n.indexed_at >= ?';
            $params[] = $sinceIso;
        } elseif ($cutoffIso) {
            $where[] = 'n.indexed_at >= ?';
            $params[] = $cutoffIso;
        }

        if ($untilIso) {
            $where[] = 'n.indexed_at <= ?';
            $params[] = $untilIso;
        }

        // Avoid NULL times in range queries.
        $where[] = 'n.indexed_at IS NOT NULL';

        if ($reasons) {
            $in = implode(',', array_fill(0, count($reasons), '?'));
            $where[] = "n.reason IN ($in)";
            foreach ($reasons as $r) $params[] = $r;
        }

        $whereSql = 'WHERE ' . implode(' AND ', $where);
        $order = $newestFirst ? 'n.indexed_at DESC' : 'n.indexed_at ASC';

        $countSql = "SELECT COUNT(*) FROM notifications n $whereSql";
        $stCount = $pdo->prepare($countSql);
        $stCount->execute($params);
        $total = (int)$stCount->fetchColumn();

        $sql = "SELECT n.notif_id AS id, n.indexed_at AS indexedAt, n.reason, n.author_did AS authorDid, n.reason_subject AS reasonSubject,
                       p.handle AS authorHandle, p.display_name AS authorDisplayName, p.avatar AS authorAvatar
                FROM notifications n
                LEFT JOIN profiles p ON p.did = n.author_did
                $whereSql
                ORDER BY $order
                LIMIT :lim OFFSET :off";

        $st = $pdo->prepare($sql);
        $i = 1;
        foreach ($params as $v) $st->bindValue($i++, $v);
        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
        $st->bindValue(':off', $offset, \PDO::PARAM_INT);
        $st->execute();

        return [
            'ok' => true,
            'since' => $sinceIso,
            'until' => $untilIso,
            'cutoffIso' => $sinceIso ?: $cutoffIso,
            'hours' => $hours,
            'items' => $st->fetchAll(\PDO::FETCH_ASSOC) ?: [],
            'total' => $total,
            'hasMore' => ($offset + $limit) < $total,
        ];
    }

    protected function cacheEnsureColumn(\PDO $pdo, string $table, string $column, string $type): void
    {
        try {
            $cols = $pdo->query("PRAGMA table_info($table)")->fetchAll(\PDO::FETCH_ASSOC) ?: [];
            foreach ($cols as $c) {
                if (($c['name'] ?? null) === $column) return;
            }
            $pdo->exec("ALTER TABLE $table ADD COLUMN $column $type");
        } catch (\Throwable $e) {
            // swallow; schema drift isn't fatal for runtime, but may reduce features.
        }
    }

    protected function cacheBackfillGroupPinsSortOrder(\PDO $pdo): void
    {
        try {
            $done = $this->cacheMetaGet($pdo, null, 'group_pins_sort_order_backfill_done');
            if ($done === '1') return;

            // If the table doesn't exist yet (or is missing the column), just bail.
            $cols = $pdo->query('PRAGMA table_info(group_pins)')->fetchAll(\PDO::FETCH_ASSOC) ?: [];
            $haveSort = false;
            foreach ($cols as $c) {
                if (($c['name'] ?? null) === 'sort_order') { $haveSort = true; break; }
            }
            if (!$haveSort) return;

            // Only touch legacy rows that still have NULL sort_order.
            $nulls = (int)($pdo->query('SELECT COUNT(1) FROM group_pins WHERE sort_order IS NULL')->fetchColumn() ?: 0);
            if ($nulls <= 0) {
                $this->cacheMetaSet($pdo, null, 'group_pins_sort_order_backfill_done', '1');
                return;
            }

            $groups = $pdo->query('SELECT DISTINCT group_id FROM group_pins WHERE sort_order IS NULL')->fetchAll(\PDO::FETCH_COLUMN, 0) ?: [];
            $stPins = $pdo->prepare('SELECT post_uri FROM group_pins WHERE group_id = :g ORDER BY pinned_at DESC');
            $stUp = $pdo->prepare('UPDATE group_pins SET sort_order = :o WHERE group_id = :g AND post_uri = :u');

            $pdo->beginTransaction();
            foreach ($groups as $gidRaw) {
                $gid = (int)$gidRaw;
                $stPins->execute([':g' => $gid]);
                $uris = $stPins->fetchAll(\PDO::FETCH_COLUMN, 0) ?: [];

                $i = 0;
                foreach ($uris as $u) {
                    $u = (string)$u;
                    $stUp->execute([':o' => $i, ':g' => $gid, ':u' => $u]);
                    $i++;
                }
            }
            $this->cacheMetaSet($pdo, null, 'group_pins_sort_order_backfill_done', '1');
            $pdo->commit();
        } catch (\Throwable $e) {
            try { if ($pdo->inTransaction()) $pdo->rollBack(); } catch (\Throwable $e2) { /* ignore */ }
            // Swallow: ordering backfill is a best-effort migration.
        }
    }

    protected function cacheLatestSnapshotInfo(\PDO $pdo, ?string $actorDid, string $kind): ?array
    {
        if (!$actorDid) return null;
        $st = $pdo->prepare('SELECT id, taken_at FROM snapshots WHERE actor_did = :a AND kind = :k ORDER BY id DESC LIMIT 1');
        $st->execute([':a' => $actorDid, ':k' => $kind]);
        $row = $st->fetch(\PDO::FETCH_ASSOC);
        if (!$row) return null;
        $sid = (int)$row['id'];
        $cnt = (int)$pdo->query("SELECT COUNT(*) FROM edges WHERE snapshot_id = {$sid}")->fetchColumn();
        return ['id' => $sid, 'takenAt' => $row['taken_at'], 'count' => $cnt];
    }

    protected function cacheNotificationsCount(\PDO $pdo, string $actorDid): int
    {
        $st = $pdo->prepare('SELECT COUNT(*) FROM notifications WHERE actor_did = :a');
        $st->execute([':a' => $actorDid]);
        return (int)$st->fetchColumn();
    }

    protected function cacheNotificationsCountSince(\PDO $pdo, string $actorDid, int $hours): int
    {
        $cutoff = new \DateTimeImmutable("-{$hours} hours");
        $st = $pdo->prepare('SELECT COUNT(*) FROM notifications WHERE actor_did = :a AND indexed_at >= :cutoff');
        $st->execute([':a' => $actorDid, ':cutoff' => $cutoff->format('c')]);
        return (int)$st->fetchColumn();
    }

    protected function cachePostsCount(\PDO $pdo, string $actorDid): int
    {
        $st = $pdo->prepare('SELECT COUNT(*) FROM posts WHERE actor_did = :a');
        $st->execute([':a' => $actorDid]);
        return (int)$st->fetchColumn();
    }

    protected function cachePostsCountSince(\PDO $pdo, string $actorDid, int $hours): int
    {
        $cutoff = new \DateTimeImmutable("-{$hours} hours");
        $st = $pdo->prepare('SELECT COUNT(*) FROM posts WHERE actor_did = :a AND created_at >= :cutoff');
        $st->execute([':a' => $actorDid, ':cutoff' => $cutoff->format('c')]);
        return (int)$st->fetchColumn();
    }

    protected function cacheFtsQuery(string $q): string
    {
        // Keep it simple: quote the whole string to treat it as a phrase.
        $q = trim($q);
        $q = str_replace('"', '""', $q);
        return '"' . $q . '"';
    }
}
