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
    protected const CACHE_SCHEMA_VERSION = '2026-01-14-1';

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
                ];

                // Guests can see status (always disconnected) but cannot store sessions.
                if (!$registered || $c5UserId <= 0) {
                    return $this->json($out);
                }

                $pdo = $this->cacheDb();
                $this->cacheMigrate($pdo);
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
                        'updatedAt' => $a['updated_at'] ?? null,
                    ];
                }, $accounts);
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
                    isset($sess['pds']) ? (string)$sess['pds'] : null
                );

                // Return profile so UI can immediately render.
                $this->pds = $sess['pds'] ?? $this->pds;
                $me = $this->xrpc('GET', 'app.bsky.actor.getProfile', $sess['accessJwt'], ['actor' => $sess['did']]);
                // Cache it for account manager + identity rendering.
                $this->cacheUpsertProfile($pdo, is_array($me) ? $me : []);
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
                    return $this->json($this->createRecord($session, 'app.bsky.feed.post', $record));
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

                        $pdo->commit();
                        return $this->json(['ok' => true, 'actorDid' => $meDid, 'syncedAt' => $now, 'minutes' => $minutes, 'notifications' => $notif, 'posts' => $posts]);
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
                    // - targets: ['people','posts','notifications']
                    // - limit: per-target max results
                    // - hours: cache window for posts/notifications
                    // - postTypes: ['post','reply','repost'] (optional)
                    // - reasons: notification reasons (optional)

                    $q = trim((string)($params['q'] ?? ''));
                    $mode = (string)($params['mode'] ?? 'cache');
                    if ($mode !== 'network') $mode = 'cache';

                    $targets = (isset($params['targets']) && is_array($params['targets']))
                        ? array_values(array_unique(array_map('strval', $params['targets'])))
                        : ['people', 'posts', 'notifications'];
                    $targets = array_values(array_filter($targets));
                    if (!$targets) $targets = ['people', 'posts', 'notifications'];

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
                        // Network mode: only people search is supported here.
                        if (in_array('people', $targets, true)) {
                            $term = $networkPeopleTerm($q);
                            if ($term === '' || strlen($term) < 2) {
                                $out['results']['people'] = [];
                            } else {
                                $res = $this->xrpcSession('GET', 'app.bsky.actor.searchActors', $session, ['term' => $term, 'limit' => $limit]);
                                $out['results']['people'] = $res['actors'] ?? [];
                            }
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

    /* ===================== SQLite cache helpers ===================== */

    protected function cacheDir(): string
    {
        // application/files is typically writable in ConcreteCMS.
        $appDir = defined('DIR_APPLICATION')
            ? (string)DIR_APPLICATION
            : (defined('DIR_BASE') ? (rtrim((string)DIR_BASE, '/') . '/application') : (dirname(__DIR__, 4) . '/application'));

        // Allow admins to relocate/rename the storage subdir later.
        $subdir = (string)(getenv('BSKY_STORAGE_SUBDIR') ?: 'concretesky');
        $subdir = trim($subdir, "/\t\n\r\0\x0B/");
        if ($subdir === '') $subdir = 'concretesky';

        $dir = rtrim($appDir, '/') . '/files/' . $subdir;

        // Backwards-compat: if the new default doesn't exist yet but the legacy dir does, reuse it.
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

    protected function cacheDb(): \PDO
    {
        $dir = $this->cacheDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        @chmod($dir, 0775);
        $path = $this->cacheDbPath();

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
                $pdo->exec('INSERT OR IGNORE INTO auth_sessions(c5_user_id,did,handle,pds,access_jwt,refresh_jwt,auth_type,auth_issuer,dpop_private_pem,dpop_public_jwk,auth_dpop_nonce,resource_dpop_nonce,token_expires_at,created_at,updated_at)
                    SELECT c5_user_id,did,handle,pds,access_jwt,refresh_jwt,auth_type,auth_issuer,dpop_private_pem,dpop_public_jwk,auth_dpop_nonce,resource_dpop_nonce,token_expires_at,created_at,updated_at FROM auth_sessions_v1');
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
            first_connected_at TEXT,
            last_connected_at TEXT,
            PRIMARY KEY(c5_user_id, did)
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_c5_accounts_user ON c5_accounts(c5_user_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_c5_accounts_did ON c5_accounts(did)');

        // If upgrading an existing DB, ensure new OAuth-related columns exist.
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'auth_type', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'auth_issuer', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'dpop_private_pem', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'dpop_public_jwk', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'auth_dpop_nonce', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'resource_dpop_nonce', 'TEXT');
        $this->cacheEnsureColumn($pdo, 'auth_sessions', 'token_expires_at', 'TEXT');

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

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_snapshots_actor_kind ON snapshots(actor_did, kind, taken_at)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_edges_actor_kind ON edges(actor_did, kind)');

        // Mark schema current.
        $this->cacheMetaSet($pdo, null, 'schema_version', self::CACHE_SCHEMA_VERSION);
    }

    protected function cacheAccountsUpsert(\PDO $pdo, int $c5UserId, string $did, ?string $handle, ?string $pds): void
    {
        $now = gmdate('c');
        $st = $pdo->prepare('INSERT INTO c5_accounts(c5_user_id, did, handle, pds, first_connected_at, last_connected_at)
            VALUES(:u,:did,:h,:pds,:t,:t)
            ON CONFLICT(c5_user_id, did) DO UPDATE SET
              handle=excluded.handle,
              pds=excluded.pds,
              last_connected_at=excluded.last_connected_at');
        $st->execute([
            ':u' => $c5UserId,
            ':did' => $did,
            ':h' => $handle,
            ':pds' => $pds,
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
