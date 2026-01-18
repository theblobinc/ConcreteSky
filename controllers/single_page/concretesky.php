<?php
namespace Concrete\Package\Concretesky\Controller\SinglePage;

use Concrete\Core\Page\Controller\PageController;
use Concrete\Core\Support\Facade\Log;
use Concrete\Core\User\User;
use Concrete\Core\User\UserInfo;
use Concrete\Core\User\Group\Group;
use Concrete\Core\Routing\Redirect;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

defined('C5_EXECUTE') or die('Access Denied.');

class Concretesky extends PageController
{
    protected $pds;
    protected $handle;      // legacy env-based identifier (no longer required)
    protected $appPassword; // legacy env-based app password (no longer required)
    protected $debug;

    public function on_start()
    {
        $this->pds         = getenv('BSKY_PDS') ?: 'https://bsky.social';
        $this->handle      = getenv('BSKY_HANDLE') ?: null;
        $this->appPassword = getenv('BSKY_APP_PASSWORD') ?: null;
        $this->debug       = (bool) (getenv('BSKY_DEBUG') ?: false);

        $this->set('csrfToken', app('token')->generate('bsky_api'));
    }

    public function view()
    {
        // Hide/deny the page for guests (also keeps it out of navs that respect permissions).
        // Note: OAuth client metadata and callback remain publicly accessible under /concretesky/oauth/*.
        $u = new User();
        if (!$u->isRegistered()) {
            return Redirect::to('/login');
        }

        $this->requireUiAccess($u->getUserInfoObject());

        $this->requireAsset('jquery');
    }

    /**
     * Optional access control for the ConcreteSky SPA + related API routes.
     * Defaults to allowing any logged-in Concrete user.
     */
    protected function requireUiAccess(?UserInfo $ui): void
    {
        if (!$this->uiAccessAllowed($ui)) {
            throw new AccessDeniedHttpException('Forbidden');
        }
    }

    protected function uiAccessAllowed(?UserInfo $ui): bool
    {
        if (!$ui) return false;

        $requireSuper = $this->boolFromEnvOrConfig('CONCRETESKY_UI_REQUIRE_SUPERUSER', 'concretesky.ui.require_superuser', false);

        $allowUsersRaw = $this->strFromEnvOrConfig('CONCRETESKY_UI_ALLOW_USERS', 'concretesky.ui.allow_users', '');
        if ($allowUsersRaw === '') {
            // Back-compat env names.
            $allowUsersRaw = trim((string)(getenv('CONCRETESKY_UI_ALLOW_USERNAMES') ?: ''));
        }

        $allowGroupsRaw = $this->strFromEnvOrConfig('CONCRETESKY_UI_ALLOW_GROUPS', 'concretesky.ui.allow_groups', '');
        if ($allowGroupsRaw === '') {
            // Back-compat env name.
            $allowGroupsRaw = trim((string)(getenv('CONCRETESKY_UI_ALLOW_GROUP') ?: ''));
        }

        // If nothing is configured, allow any logged-in user.
        if (!$requireSuper && trim($allowUsersRaw) === '' && trim($allowGroupsRaw) === '') {
            return true;
        }

        $isSuper = method_exists($ui, 'isSuperUser') ? (bool)$ui->isSuperUser() : false;
        if ($requireSuper && !$isSuper) {
            return false;
        }

        if (trim($allowUsersRaw) !== '') {
            $allow = array_values(array_filter(array_map('trim', explode(',', $allowUsersRaw))));
            $meName = method_exists($ui, 'getUserName') ? (string)$ui->getUserName() : '';
            $meId = method_exists($ui, 'getUserID') ? (int)$ui->getUserID() : 0;

            $ok = false;
            foreach ($allow as $a) {
                if ($a === '') continue;
                if ($meName !== '' && $a === $meName) { $ok = true; break; }
                if ($meId > 0 && ctype_digit($a) && (int)$a === $meId) { $ok = true; break; }
            }
            if (!$ok) return false;
        }

        if (trim($allowGroupsRaw) !== '') {
            $groups = array_values(array_filter(array_map('trim', explode(',', $allowGroupsRaw))));

            $ids = method_exists($ui, 'getUserGroups') ? (array)$ui->getUserGroups() : [];
            $ids = array_map('intval', $ids);

            $ok = false;
            foreach ($groups as $gName) {
                if ($gName === '') continue;
                try {
                    $group = Group::getByName($gName);
                    if ($group) {
                        $gID = (int)$group->getGroupID();
                        if (in_array($gID, $ids, true)) { $ok = true; break; }
                    }
                } catch (\Throwable $e) {
                    // ignore
                }
            }
            if (!$ok) return false;
        }

        return true;
    }

    protected function strFromEnvOrConfig(string $envKey, string $configKey, string $default): string
    {
        $v = getenv($envKey);
        if ($v !== false && trim((string)$v) !== '') {
            return trim((string)$v);
        }

        try {
            $cfg = app('config');
            $cv = $cfg ? $cfg->get($configKey, null) : null;
            if (is_string($cv) && trim($cv) !== '') return trim($cv);
        } catch (\Throwable $e) {
            // ignore
        }

        return $default;
    }

    protected function boolFromEnvOrConfig(string $envKey, string $configKey, bool $default): bool
    {
        $v = getenv($envKey);
        if ($v !== false) {
            $s = strtolower(trim((string)$v));
            if ($s === '1' || $s === 'true' || $s === 'yes' || $s === 'on') return true;
            if ($s === '0' || $s === 'false' || $s === 'no' || $s === 'off' || $s === '') return false;
        }

        try {
            $cfg = app('config');
            $cv = $cfg ? $cfg->get($configKey, null) : null;
            if (is_bool($cv)) return $cv;
            if (is_int($cv)) return $cv !== 0;
            if (is_string($cv)) {
                $s = strtolower(trim($cv));
                if ($s === '1' || $s === 'true' || $s === 'yes' || $s === 'on') return true;
                if ($s === '0' || $s === 'false' || $s === 'no' || $s === 'off' || $s === '') return false;
            }
        } catch (\Throwable $e) {
            // ignore
        }

        return $default;
    }

    /** ---------- helpers ---------- */

    /**
     * Resolve the base single-page path for this app from the current request.
     * This lets admins move the single page later without breaking OAuth URLs.
     */
    protected function appBasePath(): string
    {
        $fallback = '/concretesky';
        if (!isset($this->request)) return $fallback;

        $path = (string)$this->request->getPathInfo();
        if ($path === '') return $fallback;

        $path = '/' . ltrim($path, '/');

        if (str_ends_with($path, '/api')) {
            $base = substr($path, 0, -4);
            return $base !== '' ? $base : $fallback;
        }

        $pos = strpos($path, '/oauth/');
        if ($pos !== false) {
            $base = substr($path, 0, $pos);
            return $base !== '' ? $base : $fallback;
        }

        if (str_ends_with($path, '/oauth')) {
            $base = substr($path, 0, -5);
            return $base !== '' ? $base : $fallback;
        }

        return rtrim($path, '/') ?: $fallback;
    }

    protected function requireConcreteUserId(): int
    {
        $u = new User();
        if (!$u->isRegistered()) {
            throw new \RuntimeException('ConcreteCMS login required', 401);
        }
        return (int)$u->getUserID();
    }

    protected function authSessionGet(\PDO $pdo, int $c5UserId): ?array
    {
        $did = $this->authActiveDidGet($pdo, $c5UserId);

        if ($did) {
            $st = $pdo->prepare('SELECT s.c5_user_id, s.did,
                COALESCE(p.handle, s.handle) AS handle,
                                s.pds, s.client_id, s.access_jwt, s.refresh_jwt, s.auth_type, s.auth_issuer, s.dpop_private_pem, s.dpop_public_jwk, s.auth_dpop_nonce, s.resource_dpop_nonce, s.token_expires_at, s.updated_at,
                p.display_name, p.avatar
              FROM auth_sessions s
              LEFT JOIN profiles p ON p.did = s.did
              WHERE s.c5_user_id = :u AND s.did = :did
              LIMIT 1');
            $st->execute([':u' => $c5UserId, ':did' => $did]);
            $row = $st->fetch(\PDO::FETCH_ASSOC);
            if ($row) return $row;
        }

        // Fallback: pick the most recently updated session for this Concrete user.
                $st = $pdo->prepare('SELECT s.c5_user_id, s.did,
                        COALESCE(p.handle, s.handle) AS handle,
                s.pds, s.client_id, s.access_jwt, s.refresh_jwt, s.auth_type, s.auth_issuer, s.dpop_private_pem, s.dpop_public_jwk, s.auth_dpop_nonce, s.resource_dpop_nonce, s.token_expires_at, s.updated_at,
                        p.display_name, p.avatar
                    FROM auth_sessions s
                    LEFT JOIN profiles p ON p.did = s.did
                    WHERE s.c5_user_id = :u
                    ORDER BY s.updated_at DESC
                    LIMIT 1');
        $st->execute([':u' => $c5UserId]);
        $row = $st->fetch(\PDO::FETCH_ASSOC);
        if ($row && !empty($row['did'])) {
            $this->authActiveDidSet($pdo, $c5UserId, (string)$row['did']);
        }
        return $row ?: null;
    }

    protected function authSessionsList(\PDO $pdo, int $c5UserId): array
    {
        $st = $pdo->prepare('SELECT s.c5_user_id, s.did,
            COALESCE(p.handle, s.handle) AS handle,
            s.pds, s.auth_type, s.updated_at,
            p.display_name, p.avatar
          FROM auth_sessions s
          LEFT JOIN profiles p ON p.did = s.did
          WHERE s.c5_user_id = :u
          ORDER BY s.updated_at DESC');
        $st->execute([':u' => $c5UserId]);
        return $st->fetchAll(\PDO::FETCH_ASSOC) ?: [];
    }

    protected function authActiveDidKey(int $c5UserId): string
    {
        return 'c5_user:' . $c5UserId . ':active_did';
    }

    protected function authActiveDidGet(\PDO $pdo, int $c5UserId): ?string
    {
        $st = $pdo->prepare('SELECT v FROM meta WHERE k = :k LIMIT 1');
        $st->execute([':k' => $this->authActiveDidKey($c5UserId)]);
        $v = $st->fetchColumn();
        $v = $v !== false ? (string)$v : '';
        return $v !== '' ? $v : null;
    }

    protected function authActiveDidSet(\PDO $pdo, int $c5UserId, string $did): void
    {
        $st = $pdo->prepare('INSERT INTO meta(k,v,updated_at) VALUES(:k,:v,:t)
            ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at');
        $st->execute([':k' => $this->authActiveDidKey($c5UserId), ':v' => $did, ':t' => gmdate('c')]);
    }

    protected function authActiveDidClear(\PDO $pdo, int $c5UserId): void
    {
        $st = $pdo->prepare('DELETE FROM meta WHERE k = :k');
        $st->execute([':k' => $this->authActiveDidKey($c5UserId)]);
    }

    protected function authSessionUpsert(\PDO $pdo, int $c5UserId, array $sess): void
    {
        $now = gmdate('c');
        $did = (string)($sess['did'] ?? '');
        if ($did === '') {
            throw new \RuntimeException('Missing session DID');
        }

            $st = $pdo->prepare('INSERT INTO auth_sessions(c5_user_id, did, handle, pds, client_id, access_jwt, refresh_jwt, auth_type, auth_issuer, dpop_private_pem, dpop_public_jwk, auth_dpop_nonce, resource_dpop_nonce, token_expires_at, created_at, updated_at)
                VALUES(:u,:did,:h,:pds,:client_id,:a,:r,:type,:iss,:dpop_priv,:dpop_pub,:auth_nonce,:res_nonce,:exp,:c,:t)
            ON CONFLICT(c5_user_id, did) DO UPDATE SET
              handle=excluded.handle,
              pds=excluded.pds,
              client_id=excluded.client_id,
              access_jwt=excluded.access_jwt,
              refresh_jwt=excluded.refresh_jwt,
              auth_type=excluded.auth_type,
              auth_issuer=excluded.auth_issuer,
              dpop_private_pem=excluded.dpop_private_pem,
              dpop_public_jwk=excluded.dpop_public_jwk,
              auth_dpop_nonce=excluded.auth_dpop_nonce,
              resource_dpop_nonce=excluded.resource_dpop_nonce,
              token_expires_at=excluded.token_expires_at,
              updated_at=excluded.updated_at');
        $st->execute([
            ':u' => $c5UserId,
            ':did' => $did,
            ':h' => isset($sess['handle']) ? (string)$sess['handle'] : null,
            ':pds' => isset($sess['pds']) ? (string)$sess['pds'] : $this->pds,
            ':client_id' => isset($sess['clientId']) ? (string)$sess['clientId'] : null,
            ':a' => (string)($sess['accessJwt'] ?? ''),
            ':r' => (string)($sess['refreshJwt'] ?? ''),
                        ':type' => isset($sess['authType']) ? (string)$sess['authType'] : 'password',
                        ':iss' => isset($sess['authIssuer']) ? (string)$sess['authIssuer'] : null,
                        ':dpop_priv' => isset($sess['dpopPrivatePem']) ? (string)$sess['dpopPrivatePem'] : null,
                        ':dpop_pub' => isset($sess['dpopPublicJwk']) ? json_encode($sess['dpopPublicJwk'], JSON_UNESCAPED_SLASHES) : null,
                        ':auth_nonce' => isset($sess['authDpopNonce']) ? (string)$sess['authDpopNonce'] : null,
                        ':res_nonce' => isset($sess['resourceDpopNonce']) ? (string)$sess['resourceDpopNonce'] : null,
                        ':exp' => isset($sess['tokenExpiresAt']) ? (string)$sess['tokenExpiresAt'] : null,
            ':c' => $now,
            ':t' => $now,
        ]);

        // Make this account the active account for this Concrete user.
        $this->authActiveDidSet($pdo, $c5UserId, $did);
    }

    protected function authSessionDelete(\PDO $pdo, int $c5UserId, ?string $did = null): void
    {
        if ($did) {
            $st = $pdo->prepare('DELETE FROM auth_sessions WHERE c5_user_id = :u AND did = :did');
            $st->execute([':u' => $c5UserId, ':did' => $did]);
        } else {
            $st = $pdo->prepare('DELETE FROM auth_sessions WHERE c5_user_id = :u');
            $st->execute([':u' => $c5UserId]);
        }
    }

    /**
     * SQLite cache DB handle.
     * Implemented/overridden in the API controller; defined here to keep static analysis happy.
     */
    protected function cacheDb(): \PDO
    {
        throw new \RuntimeException('cacheDb() is only available in the API controller');
    }

    /**
     * Cache/schema migration.
     * Implemented/overridden in the API controller; defined here to keep static analysis happy.
     */
    protected function cacheMigrate(\PDO $pdo): void
    {
        // no-op
    }

    protected function ensureSession()
    {
        $c5UserId = $this->requireConcreteUserId();

        // Session tokens are stored server-side (SQLite), keyed to the Concrete user.
        // cacheDb()/cacheMigrate() are implemented in the API controller.
        $pdo = $this->cacheDb();
        $this->cacheMigrate($pdo);

        $row = $this->authSessionGet($pdo, $c5UserId);
        if (!$row || empty($row['access_jwt']) || empty($row['refresh_jwt']) || empty($row['did'])) {
            throw new \RuntimeException('Not connected to Bluesky. Use the Connect/Login button.', 401);
        }

        $authType = (string)($row['auth_type'] ?: 'password');

        // Per-user PDS.
        $this->pds = $row['pds'] ?: $this->pds;

        $sess = [
            'authType' => $authType,
            'accessJwt' => (string)$row['access_jwt'],
            'refreshJwt' => (string)$row['refresh_jwt'],
            'did' => (string)$row['did'],
            'handle' => (string)($row['handle'] ?? ''),
            'pds' => (string)($row['pds'] ?? $this->pds),
            'clientId' => isset($row['client_id']) ? (string)$row['client_id'] : null,
            'authIssuer' => isset($row['auth_issuer']) ? (string)$row['auth_issuer'] : null,
            'dpopPrivatePem' => isset($row['dpop_private_pem']) ? (string)$row['dpop_private_pem'] : null,
            'dpopPublicJwk' => !empty($row['dpop_public_jwk']) ? (json_decode((string)$row['dpop_public_jwk'], true) ?: null) : null,
            'authDpopNonce' => isset($row['auth_dpop_nonce']) ? (string)$row['auth_dpop_nonce'] : null,
            'resourceDpopNonce' => isset($row['resource_dpop_nonce']) ? (string)$row['resource_dpop_nonce'] : null,
            'tokenExpiresAt' => isset($row['token_expires_at']) ? (string)$row['token_expires_at'] : null,
        ];

        return $this->maybeRefresh($sess, $pdo, $c5UserId);
    }

    protected function maybeRefresh($session, ?\PDO $pdo = null, int $c5UserId = 0)
	{
        // OAuth sessions refresh via the OAuth token endpoint.
        if (is_array($session) && (($session['authType'] ?? 'password') === 'oauth')) {
            $expIso = $session['tokenExpiresAt'] ?? null;
            $expTs = $expIso ? strtotime((string)$expIso) : null;
            // Refresh if expiry is missing or within ~2 minutes.
            if ($expTs === null || $expTs <= (time() + 120)) {
                try {
                    $issuer = (string)($session['authIssuer'] ?? '');
                    if ($issuer === '') throw new \RuntimeException('Missing OAuth issuer');
                    $asMeta = $this->oauthFetchAuthServerMetadata($issuer);
                    $nonce = $session['authDpopNonce'] ?? null;
                    $dpopKeypair = [
                        'private_pem' => (string)($session['dpopPrivatePem'] ?? ''),
                        'public_jwk' => $session['dpopPublicJwk'] ?? null,
                    ];
                    if ($dpopKeypair['private_pem'] === '' || !is_array($dpopKeypair['public_jwk'])) {
                        throw new \RuntimeException('Missing DPoP key material');
                    }
                    $clientId = (string)($session['clientId'] ?? '');
                    // Client ID is deterministic for this app; derive if not explicitly present.
                    if ($clientId === '' && isset($this->request)) {
                        $host = rtrim((string)$this->request->getSchemeAndHttpHost(), '/');
                        $clientId = $host . $this->appBasePath() . '/oauth/client_metadata';
                    }
                    $tok = $this->oauthToken($asMeta, [
                        'grant_type' => 'refresh_token',
                        'refresh_token' => (string)($session['refreshJwt'] ?? ''),
                        'client_id' => $clientId,
                    ], $dpopKeypair, $nonce);

                    $session['accessJwt'] = (string)($tok['access_token'] ?? $session['accessJwt']);
                    $session['refreshJwt'] = (string)($tok['refresh_token'] ?? $session['refreshJwt']);
                    $session['authDpopNonce'] = $nonce;
                    if (!empty($tok['expires_in']) && is_numeric($tok['expires_in'])) {
                        $session['tokenExpiresAt'] = gmdate('c', time() + (int)$tok['expires_in']);
                    }

                    if ($pdo && $c5UserId > 0) {
                        $this->authSessionUpsert($pdo, $c5UserId, $session);
                    }
                } catch (\Throwable $e) {
                    if ($pdo && $c5UserId > 0) {
                        $did = (string)($session['did'] ?? '');
                        if ($did !== '') {
                            $this->authSessionDelete($pdo, $c5UserId, $did);
                        }
                        $this->authActiveDidClear($pdo, $c5UserId);
                        $this->authSessionGet($pdo, $c5UserId);
                    }
                    throw new \RuntimeException('Bluesky OAuth session expired. Please reconnect.', 401);
                }
            }
            return $session;
        }

		try {
			$resp = $this->http(
				'POST',
				"{$this->pds}/xrpc/com.atproto.server.refreshSession",
				null,
				["Authorization: Bearer {$session['refreshJwt']}"]
			);
			if (isset($resp['accessJwt'], $resp['refreshJwt'])) {
				// Persist refreshed tokens for this Concrete user.
				if ($pdo && $c5UserId > 0) {
					$resp['did'] = $resp['did'] ?? ($session['did'] ?? null);
					$resp['handle'] = $resp['handle'] ?? ($session['handle'] ?? null);
					$resp['pds'] = $session['pds'] ?? $this->pds;
					$this->authSessionUpsert($pdo, $c5UserId, $resp);
				}
				return array_merge($session, $resp);
			}
			return $session;
		} catch (\Throwable $e) {
            // Refresh expired; remove the active account session only.
            if ($pdo && $c5UserId > 0) {
                $did = is_array($session) ? (string)($session['did'] ?? '') : '';
                if ($did !== '') {
                    $this->authSessionDelete($pdo, $c5UserId, $did);
                }
                $this->authActiveDidClear($pdo, $c5UserId);
                // Pick another account if available.
                $this->authSessionGet($pdo, $c5UserId);
            }
            throw new \RuntimeException('Bluesky session expired. Please reconnect.', 401);
		}
	}

    protected function createSessionWithPassword(string $identifier, string $password, ?string $pds = null): array
    {
        $pds = $pds ?: $this->pds;
        $prev = $this->pds;
        $this->pds = $pds;
        try {
            $resp = $this->http('POST', "{$this->pds}/xrpc/com.atproto.server.createSession", [
                'identifier' => $identifier,
                'password' => $password,
            ]);
        } finally {
            $this->pds = $prev;
        }

        if (!isset($resp['accessJwt'], $resp['refreshJwt'], $resp['did'])) {
            throw new \RuntimeException('Failed to create Bluesky session');
        }
        $resp['pds'] = $pds;
        return $resp;
    }

    /**
     * Build query string with repeated keys (actors=did1&actors=did2) instead of PHP brackets.
     */
    protected function buildQueryString(array $query): string
    {
        if (!$query) return '';
        $parts = [];
        foreach ($query as $k => $v) {
            if ($v === null) continue;
            if (is_array($v)) {
                foreach ($v as $vv) {
                    if ($vv === null) continue;
                    $parts[] = rawurlencode($k) . '=' . rawurlencode((string)$vv);
                }
            } else {
                $parts[] = rawurlencode($k) . '=' . rawurlencode((string)$v);
            }
        }
        return $parts ? ('?' . implode('&', $parts)) : '';
    }

    protected function xrpc($verb, $nsid, $accessJwt, array $query = [], ?array $json = null)
    {
        $url = "{$this->pds}/xrpc/{$nsid}" . $this->buildQueryString($query);
        if ($this->debug) {
            Log::debug('[BSKY xrpc] ' . $verb . ' ' . $url . ($json ? ' body=' . json_encode($json) : ''));
        }
        return $this->http($verb, $url, $json, [
            "Authorization: Bearer {$accessJwt}",
            'Content-Type: application/json',
        ]);
    }

    /**
     * Session-aware XRPC.
     * - password sessions use legacy Bearer auth
     * - oauth sessions use DPoP-bound access tokens
     */
    protected function xrpcSession(string $verb, string $nsid, array &$session, array $query = [], ?array $json = null)
    {
        $url = "{$this->pds}/xrpc/{$nsid}" . $this->buildQueryString($query);
        if ($this->debug) {
            Log::debug('[BSKY xrpcSession] ' . $verb . ' ' . $url . ($json ? ' body=' . json_encode($json) : ''));
        }

        $authType = (string)($session['authType'] ?? 'password');
        if ($authType !== 'oauth') {
            return $this->http($verb, $url, $json, [
                "Authorization: Bearer {$session['accessJwt']}",
                'Content-Type: application/json',
            ]);
        }

        return $this->oauthXrpc($verb, $url, $session, $json);
    }

    protected function createRecord(array &$session, $collection, array $record, $rkey = null)
    {
        $repo = $session['did'] ?? ($session['handle'] ?? null);
        if (!$repo) throw new \RuntimeException('Missing repo DID for createRecord');
        $payload = ['repo' => $repo, 'collection' => $collection, 'record' => $record];
        if ($rkey !== null && $rkey !== '') {
            $payload['rkey'] = (string)$rkey;
        }
        if (($session['authType'] ?? 'password') === 'oauth') {
            return $this->oauthXrpc('POST', "{$this->pds}/xrpc/com.atproto.repo.createRecord", $session, $payload);
        }
        return $this->http('POST', "{$this->pds}/xrpc/com.atproto.repo.createRecord", $payload, [
            "Authorization: Bearer {$session['accessJwt']}",
            'Content-Type: application/json',
        ]);
    }

    protected function deleteRecord($session, $collection, $rkey)
    {
        $repo = $session['did'] ?? ($session['handle'] ?? null);
        if (!$repo) throw new \RuntimeException('Missing repo DID for deleteRecord');
        $payload = ['repo' => $repo, 'collection' => $collection, 'rkey' => $rkey];
        if (($session['authType'] ?? 'password') === 'oauth') {
            return $this->oauthXrpc('POST', "{$this->pds}/xrpc/com.atproto.repo.deleteRecord", $session, $payload);
        }
        return $this->http('POST', "{$this->pds}/xrpc/com.atproto.repo.deleteRecord", $payload, [
            "Authorization: Bearer {$session['accessJwt']}",
            'Content-Type: application/json',
        ]);
    }

    protected function listRecords($session, $collection, $limit = 100, $cursor = null)
    {
        $repo = $session['did'] ?? ($session['handle'] ?? null);
        if (!$repo) throw new \RuntimeException('Missing repo DID for listRecords');
        $query = ['repo' => $repo, 'collection' => $collection, 'limit' => $limit, 'cursor' => $cursor];
        if (($session['authType'] ?? 'password') === 'oauth') {
            return $this->xrpcSession('GET', 'com.atproto.repo.listRecords', $session, $query);
        }
        return $this->xrpc('GET', 'com.atproto.repo.listRecords', $session['accessJwt'], $query);
    }

    /* ===================== OAuth / DPoP helpers ===================== */

    protected function b64urlEncode(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    protected function sha256B64url(string $data): string
    {
        return $this->b64urlEncode(hash('sha256', $data, true));
    }

    protected function oauthRandomToken(int $bytes = 32): string
    {
        return $this->b64urlEncode(random_bytes($bytes));
    }

    protected function oauthPkce(): array
    {
        $verifier = $this->oauthRandomToken(48);
        $challenge = $this->sha256B64url($verifier);
        return ['verifier' => $verifier, 'challenge' => $challenge, 'method' => 'S256'];
    }

    protected function ecGenerateP256(): array
    {
        $res = openssl_pkey_new([
            'private_key_type' => OPENSSL_KEYTYPE_EC,
            'curve_name' => 'prime256v1',
        ]);
        if (!$res) throw new \RuntimeException('Failed to generate EC keypair');

        $privPem = '';
        if (!openssl_pkey_export($res, $privPem)) {
            throw new \RuntimeException('Failed to export EC private key');
        }

        $details = openssl_pkey_get_details($res);
        if (!$details || empty($details['ec']['x']) || empty($details['ec']['y'])) {
            throw new \RuntimeException('Failed to read EC public key details');
        }

        $jwk = [
            'kty' => 'EC',
            'crv' => 'P-256',
            'x' => $this->b64urlEncode($details['ec']['x']),
            'y' => $this->b64urlEncode($details['ec']['y']),
        ];

        return ['private_pem' => $privPem, 'public_jwk' => $jwk];
    }

    protected function ecdsaDerToJose(string $der, int $partLen = 32): string
    {
        // Parse ASN.1 DER ECDSA signature into JOSE (raw R|S).
        $pos = 0;
        $len = strlen($der);
        if ($len < 8 || ord($der[$pos++]) !== 0x30) throw new \RuntimeException('Invalid ECDSA DER signature');

        $seqLen = ord($der[$pos++]);
        if ($seqLen & 0x80) {
            $n = $seqLen & 0x7f;
            if ($n < 1 || $n > 2) throw new \RuntimeException('Invalid ECDSA DER length');
            $seqLen = 0;
            for ($i = 0; $i < $n; $i++) $seqLen = ($seqLen << 8) | ord($der[$pos++]);
        }

        if (ord($der[$pos++]) !== 0x02) throw new \RuntimeException('Invalid ECDSA DER signature');
        $rLen = ord($der[$pos++]);
        $r = substr($der, $pos, $rLen);
        $pos += $rLen;

        if (ord($der[$pos++]) !== 0x02) throw new \RuntimeException('Invalid ECDSA DER signature');
        $sLen = ord($der[$pos++]);
        $s = substr($der, $pos, $sLen);

        $r = ltrim($r, "\x00");
        $s = ltrim($s, "\x00");
        $r = str_pad($r, $partLen, "\x00", STR_PAD_LEFT);
        $s = str_pad($s, $partLen, "\x00", STR_PAD_LEFT);
        if (strlen($r) !== $partLen || strlen($s) !== $partLen) throw new \RuntimeException('Invalid ECDSA signature size');

        return $this->b64urlEncode($r . $s);
    }

    protected function jwtEs256(array $header, array $payload, string $privatePem): string
    {
        $h = $this->b64urlEncode(json_encode($header, JSON_UNESCAPED_SLASHES));
        $p = $this->b64urlEncode(json_encode($payload, JSON_UNESCAPED_SLASHES));
        $data = $h . '.' . $p;

        $sigDer = '';
        if (!openssl_sign($data, $sigDer, $privatePem, OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('Failed to sign ES256 JWT');
        }
        $sig = $this->ecdsaDerToJose($sigDer, 32);
        return $data . '.' . $sig;
    }

    protected function dpopProof(string $privatePem, array $publicJwk, string $method, string $url, ?string $nonce = null, ?string $accessToken = null): string
    {
        $payload = [
            'jti' => $this->oauthRandomToken(16),
            'htm' => strtoupper($method),
            'htu' => $url,
            'iat' => time(),
        ];
        if ($nonce) $payload['nonce'] = $nonce;
        if ($accessToken) $payload['ath'] = $this->sha256B64url($accessToken);

        $header = [
            'typ' => 'dpop+jwt',
            'alg' => 'ES256',
            'jwk' => $publicJwk,
        ];
        return $this->jwtEs256($header, $payload, $privatePem);
    }

    protected function httpRaw(string $verb, string $url, $body = null, array $headers = [], ?string $contentType = null): array
    {
        $respHeaders = [];
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $verb,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_TIMEOUT        => 25,
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
                // IMPORTANT: Must return the exact length of the *original* header line.
                // Returning a different value can produce: "cURL error: Failed writing header".
                $len = strlen($line);

                try {
                    $t = trim($line);
                    if ($t === '' || stripos($t, 'HTTP/') === 0) return $len;
                    $p = strpos($t, ':');
                    if ($p === false) return $len;
                    $k = strtolower(trim(substr($t, 0, $p)));
                    $v = trim(substr($t, $p + 1));
                    if ($k !== '') {
                        $respHeaders[$k] = $v;
                    }
                } catch (\Throwable $e) {
                    // Never let parsing failures break the HTTP request.
                }

                return $len;
            },
        ]);

        if ($body !== null) {
            if (is_array($body) && ($contentType === null || $contentType === 'application/json')) {
                $body = json_encode($body);
                $contentType = 'application/json';
            } elseif (is_array($body) && $contentType === 'application/x-www-form-urlencoded') {
                $body = http_build_query($body);
            }
            if ($contentType) {
                $hasCT = false;
                foreach ($headers as $h) if (stripos($h, 'content-type:') === 0) $hasCT = true;
                if (!$hasCT) {
                    curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge($headers, ["Content-Type: {$contentType}"]));
                }
            }
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $raw = curl_exec($ch);
        if ($raw === false) throw new \RuntimeException('cURL error: ' . curl_error($ch));
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $json = null;
        $ct = $respHeaders['content-type'] ?? '';
        if (stripos($ct, 'application/json') !== false) {
            $json = json_decode($raw, true);
        } else {
            // Try JSON anyway (some servers omit content-type).
            $tmp = json_decode($raw, true);
            if (is_array($tmp)) $json = $tmp;
        }

        return ['status' => $code, 'headers' => $respHeaders, 'text' => $raw, 'json' => $json];
    }

    protected function oauthFetchAuthServerMetadata(string $issuer): array
    {
        $issuer = rtrim($issuer, '/');
        $url = $issuer . '/.well-known/oauth-authorization-server';
        $r = $this->httpRaw('GET', $url, null, ['Accept: application/json']);
        if ($r['status'] !== 200 || !is_array($r['json'])) {
            throw new \RuntimeException('OAuth metadata fetch failed: ' . $issuer);
        }
        $meta = $r['json'];
        if (empty($meta['issuer']) || rtrim((string)$meta['issuer'], '/') !== $issuer) {
            throw new \RuntimeException('OAuth issuer mismatch');
        }
        return $meta;
    }

    protected function oauthPar(array $asMeta, string $clientId, string $redirectUri, string $scope, string $state, string $codeChallenge, ?string $loginHint, array $dpopKeypair, ?string &$nonce = null): array
    {
        $parUrl = (string)($asMeta['pushed_authorization_request_endpoint'] ?? '');
        if ($parUrl === '') throw new \RuntimeException('OAuth PAR endpoint missing');

        // login_hint is optional. The Bluesky/ATProto auth server can reject malformed values
        // (e.g. user types "@handle" or leaves only "@domain"). Normalize common inputs.
        if ($loginHint !== null) {
            $loginHint = trim($loginHint);
            if ($loginHint !== '' && str_starts_with($loginHint, '@')) {
                $loginHint = ltrim($loginHint, '@');
            }
            if ($loginHint === '') {
                $loginHint = null;
            }
        }

        $params = [
            'client_id' => $clientId,
            'response_type' => 'code',
            'code_challenge' => $codeChallenge,
            'code_challenge_method' => 'S256',
            'redirect_uri' => $redirectUri,
            'scope' => $scope,
            'state' => $state,
        ];
        if ($loginHint) $params['login_hint'] = $loginHint;

        for ($i = 0; $i < 2; $i++) {
            $dpop = $this->dpopProof($dpopKeypair['private_pem'], $dpopKeypair['public_jwk'], 'POST', $parUrl, $nonce);
            $r = $this->httpRaw('POST', $parUrl, $params, ['DPoP: ' . $dpop, 'Accept: application/json'], 'application/x-www-form-urlencoded');
            $nonceHdr = $r['headers']['dpop-nonce'] ?? null;
            if ($nonceHdr) $nonce = $nonceHdr;

            if ($r['status'] >= 200 && $r['status'] < 300 && is_array($r['json']) && !empty($r['json']['request_uri'])) {
                return $r['json'];
            }

            $err = is_array($r['json']) ? ($r['json']['error'] ?? null) : null;
            if ($err === 'use_dpop_nonce' && $nonceHdr && $i === 0) {
                continue;
            }

            $msg = is_array($r['json']) ? json_encode($r['json']) : $r['text'];
            throw new \RuntimeException('OAuth PAR failed: HTTP ' . $r['status'] . ' ' . $msg);
        }

        throw new \RuntimeException('OAuth PAR failed');
    }

    protected function oauthToken(array $asMeta, array $params, array $dpopKeypair, ?string &$nonce = null): array
    {
        $tokenUrl = (string)($asMeta['token_endpoint'] ?? '');
        if ($tokenUrl === '') throw new \RuntimeException('OAuth token endpoint missing');

        for ($i = 0; $i < 2; $i++) {
            $dpop = $this->dpopProof($dpopKeypair['private_pem'], $dpopKeypair['public_jwk'], 'POST', $tokenUrl, $nonce);
            $r = $this->httpRaw('POST', $tokenUrl, $params, ['DPoP: ' . $dpop, 'Accept: application/json'], 'application/x-www-form-urlencoded');
            $nonceHdr = $r['headers']['dpop-nonce'] ?? null;
            if ($nonceHdr) $nonce = $nonceHdr;

            if ($r['status'] >= 200 && $r['status'] < 300 && is_array($r['json']) && !empty($r['json']['access_token'])) {
                return $r['json'];
            }

            $err = is_array($r['json']) ? ($r['json']['error'] ?? null) : null;
            if ($err === 'use_dpop_nonce' && $nonceHdr && $i === 0) {
                continue;
            }

            $msg = is_array($r['json']) ? json_encode($r['json']) : $r['text'];
            throw new \RuntimeException('OAuth token request failed: HTTP ' . $r['status'] . ' ' . $msg);
        }

        throw new \RuntimeException('OAuth token request failed');
    }

    protected function resolvePdsFromDid(string $did): ?string
    {
        if (str_starts_with($did, 'did:plc:')) {
            $r = $this->httpRaw('GET', 'https://plc.directory/' . rawurlencode($did), null, ['Accept: application/json']);
            if ($r['status'] !== 200 || !is_array($r['json'])) return null;
            $doc = $r['json'];
            $svcs = $doc['service'] ?? [];
            if (is_array($svcs)) {
                foreach ($svcs as $svc) {
                    if (!is_array($svc)) continue;
                    if (($svc['type'] ?? null) === 'AtprotoPersonalDataServer' && !empty($svc['serviceEndpoint'])) {
                        return rtrim((string)$svc['serviceEndpoint'], '/');
                    }
                }
            }
            return null;
        }

        if (str_starts_with($did, 'did:web:')) {
            $host = substr($did, strlen('did:web:'));
            $host = str_replace(':', '/', $host);
            $r = $this->httpRaw('GET', 'https://' . $host . '/.well-known/did.json', null, ['Accept: application/json']);
            if ($r['status'] !== 200 || !is_array($r['json'])) return null;
            $doc = $r['json'];
            $svcs = $doc['service'] ?? [];
            if (is_array($svcs)) {
                foreach ($svcs as $svc) {
                    if (!is_array($svc)) continue;
                    if (($svc['type'] ?? null) === 'AtprotoPersonalDataServer' && !empty($svc['serviceEndpoint'])) {
                        return rtrim((string)$svc['serviceEndpoint'], '/');
                    }
                }
            }
            return null;
        }

        return null;
    }

    protected function oauthXrpc(string $verb, string $url, array &$session, $json = null)
    {
        $accessToken = (string)($session['accessJwt'] ?? '');
        $privPem = (string)($session['dpopPrivatePem'] ?? '');
        $pubJwk = $session['dpopPublicJwk'] ?? null;
        if ($accessToken === '' || $privPem === '' || !is_array($pubJwk)) {
            throw new \RuntimeException('Missing OAuth session material');
        }

        $nonce = $session['resourceDpopNonce'] ?? null;
        $dpop = $this->dpopProof($privPem, $pubJwk, $verb, $url, $nonce ?: null, $accessToken);

        $headers = [
            'Authorization: DPoP ' . $accessToken,
            'DPoP: ' . $dpop,
            'Accept: application/json',
            'Content-Type: application/json',
        ];

        // Attempt request; retry once if nonce required.
        $r = $this->httpRaw($verb, $url, $json, $headers, 'application/json');
        $nonceHdr = $r['headers']['dpop-nonce'] ?? null;
        if ($nonceHdr) {
            $session['resourceDpopNonce'] = $nonceHdr;
        }

        if ($r['status'] === 401) {
            $www = $r['headers']['www-authenticate'] ?? '';
            if (stripos($www, 'use_dpop_nonce') !== false && $nonceHdr) {
                $dpop = $this->dpopProof($privPem, $pubJwk, $verb, $url, $nonceHdr, $accessToken);
                $headers = [
                    'Authorization: DPoP ' . $accessToken,
                    'DPoP: ' . $dpop,
                    'Accept: application/json',
                    'Content-Type: application/json',
                ];
                $r = $this->httpRaw($verb, $url, $json, $headers, 'application/json');
            }
        }

        if ($r['status'] >= 400) {
            $msg = is_array($r['json']) ? ($r['json']['message'] ?? ($r['json']['error'] ?? json_encode($r['json']))) : $r['text'];
            $hint = '';
            if ($r['status'] === 429) {
                $ra = $r['headers']['retry-after'] ?? null;
                if ($ra) $hint = ' (retry-after: ' . $ra . ')';
            }
            throw new \RuntimeException('HTTP ' . $r['status'] . ': ' . $msg . $hint);
        }

        return $r['json'] ?? ['raw' => $r['text']];
    }

    /**
     * OAuth/DPoP XRPC for non-JSON bodies (e.g. com.atproto.repo.uploadBlob).
     *
     * @return array Decoded JSON response (preferred) or ['raw' => string]
     */
    protected function oauthXrpcRaw(string $verb, string $url, array &$session, string $body, string $contentType, array $extraHeaders = [])
    {
        $accessToken = (string)($session['accessJwt'] ?? '');
        $privPem = (string)($session['dpopPrivatePem'] ?? '');
        $pubJwk = $session['dpopPublicJwk'] ?? null;
        if ($accessToken === '' || $privPem === '' || !is_array($pubJwk)) {
            throw new \RuntimeException('Missing OAuth session material');
        }

        $nonce = $session['resourceDpopNonce'] ?? null;
        $dpop = $this->dpopProof($privPem, $pubJwk, $verb, $url, $nonce ?: null, $accessToken);

        $headers = array_merge([
            'Authorization: DPoP ' . $accessToken,
            'DPoP: ' . $dpop,
            'Accept: application/json',
        ], $extraHeaders);

        // Attempt request; retry once if nonce required.
        $r = $this->httpRaw($verb, $url, $body, $headers, $contentType);
        $nonceHdr = $r['headers']['dpop-nonce'] ?? null;
        if ($nonceHdr) {
            $session['resourceDpopNonce'] = $nonceHdr;
        }

        if ($r['status'] === 401) {
            $www = $r['headers']['www-authenticate'] ?? '';
            if (stripos($www, 'use_dpop_nonce') !== false && $nonceHdr) {
                $dpop = $this->dpopProof($privPem, $pubJwk, $verb, $url, $nonceHdr, $accessToken);
                $headers = array_merge([
                    'Authorization: DPoP ' . $accessToken,
                    'DPoP: ' . $dpop,
                    'Accept: application/json',
                ], $extraHeaders);
                $r = $this->httpRaw($verb, $url, $body, $headers, $contentType);
            }
        }

        if ($r['status'] >= 400) {
            $msg = is_array($r['json']) ? ($r['json']['message'] ?? ($r['json']['error'] ?? json_encode($r['json']))) : $r['text'];
            $hint = '';
            if ($r['status'] === 429) {
                $ra = $r['headers']['retry-after'] ?? null;
                if ($ra) $hint = ' (retry-after: ' . $ra . ')';
            }
            throw new \RuntimeException('HTTP ' . $r['status'] . ': ' . $msg . $hint);
        }

        return $r['json'] ?? ['raw' => $r['text']];
    }

    protected function http($verb, $url, $json = null, array $headers = [])
    {
        // Legacy HTTP helper used by non-OAuth flows.
        // Use httpRaw so we can capture headers (notably Retry-After for 429s).
        $r = $this->httpRaw($verb, $url, $json, $headers, 'application/json');
        if ($r['status'] >= 400) {
            if ($this->debug) {
                Log::debug('[BSKY http error] ' . $r['status'] . ' url=' . $url . ' body=' . (string)($r['text'] ?? ''));
            }
            $msg = is_array($r['json']) ? ($r['json']['message'] ?? ($r['json']['error'] ?? json_encode($r['json']))) : (string)($r['text'] ?? '');
            $hint = '';
            if ($r['status'] === 429) {
                $ra = $r['headers']['retry-after'] ?? null;
                if ($ra) $hint = ' (retry-after: ' . $ra . ')';
            }
            throw new \RuntimeException('HTTP ' . $r['status'] . ': ' . $msg . $hint);
        }
        return $r['json'] ?? ['raw' => $r['text']];
    }
}
