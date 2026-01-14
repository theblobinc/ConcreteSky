<?php
namespace Concrete\Package\Concretesky\Controller\SinglePage\Concretesky\Oauth;

use Concrete\Package\Concretesky\Controller\SinglePage\Concretesky\Api as ApiController;
use Concrete\Core\Support\Facade\Log;
use Symfony\Component\HttpFoundation\Response;

defined('C5_EXECUTE') or die('Access Denied.');

class Callback extends ApiController
{
    public function view()
    {
        // OAuth callback is a GET redirect from the Authorization Server.
        $state = (string)($this->request->query->get('state') ?? '');
        $code  = (string)($this->request->query->get('code') ?? '');
        $iss   = (string)($this->request->query->get('iss') ?? '');

        $ok = false;
        $err = null;
        $did = null;
        $handle = null;
        $profile = null;

        try {
            if ($state === '' || $code === '' || $iss === '') {
                throw new \RuntimeException('Missing OAuth callback parameters');
            }

            $c5UserId = $this->requireConcreteUserId();

            $pdo = $this->cacheDb();
            $this->cacheMigrate($pdo);

            $st = $pdo->prepare('SELECT state, c5_user_id, issuer, code_verifier, dpop_private_pem, dpop_public_jwk, login_hint FROM oauth_states WHERE state = :s LIMIT 1');
            $st->execute([':s' => $state]);
            $row = $st->fetch(\PDO::FETCH_ASSOC);
            if (!$row) {
                throw new \RuntimeException('OAuth state not found (try connecting again)');
            }
            if ((int)$row['c5_user_id'] !== (int)$c5UserId) {
                throw new \RuntimeException('OAuth state does not match current Concrete user');
            }

            $expectedIss = rtrim((string)$row['issuer'], '/');
            $iss = rtrim($iss, '/');
            if ($expectedIss !== $iss) {
                throw new \RuntimeException('OAuth issuer mismatch');
            }

            $host = rtrim((string)$this->request->getSchemeAndHttpHost(), '/');
            $base = $this->appBasePath();
            $clientId = $host . $base . '/oauth/client_metadata';
            $redirectUri = $host . $base . '/oauth/callback';

            $dpopKeypair = [
                'private_pem' => (string)$row['dpop_private_pem'],
                'public_jwk' => json_decode((string)$row['dpop_public_jwk'], true) ?: null,
            ];
            if ($dpopKeypair['private_pem'] === '' || !is_array($dpopKeypair['public_jwk'])) {
                throw new \RuntimeException('Missing DPoP key material');
            }

            $asMeta = $this->oauthFetchAuthServerMetadata($iss);
            $nonce = null;
            $tok = $this->oauthToken($asMeta, [
                'grant_type' => 'authorization_code',
                'code' => $code,
                'redirect_uri' => $redirectUri,
                'client_id' => $clientId,
                'code_verifier' => (string)$row['code_verifier'],
            ], $dpopKeypair, $nonce);

            $scope = (string)($tok['scope'] ?? '');
            if ($scope === '' || stripos($scope, 'atproto') === false) {
                throw new \RuntimeException('OAuth token response missing required atproto scope');
            }

            $did = (string)($tok['sub'] ?? '');
            if ($did === '') {
                throw new \RuntimeException('OAuth token response missing sub (DID)');
            }

            $access = (string)($tok['access_token'] ?? '');
            $refresh = (string)($tok['refresh_token'] ?? '');
            if ($access === '' || $refresh === '') {
                throw new \RuntimeException('OAuth token response missing access/refresh token');
            }

            $pds = $this->resolvePdsFromDid($did);
            if (!$pds) {
                // Fallback to issuer if we can't resolve; should still work for bsky.social hosted accounts.
                $pds = $iss;
            }

            $sess = [
                'authType' => 'oauth',
                'did' => $did,
                'handle' => $handle,
                'pds' => $pds,
                'clientId' => $clientId,
                'accessJwt' => $access,
                'refreshJwt' => $refresh,
                'authIssuer' => $iss,
                'dpopPrivatePem' => $dpopKeypair['private_pem'],
                'dpopPublicJwk' => $dpopKeypair['public_jwk'],
                'authDpopNonce' => $nonce,
            ];
            if (!empty($tok['expires_in']) && is_numeric($tok['expires_in'])) {
                $sess['tokenExpiresAt'] = gmdate('c', time() + (int)$tok['expires_in']);
            }

            // Fetch profile so we can persist handle + display name in the local cache.
            try {
                $profile = $this->oauthXrpc('GET', $pds . '/xrpc/app.bsky.actor.getProfile?actor=' . rawurlencode($did), $sess);
                if (is_array($profile)) {
                    $handle = isset($profile['handle']) ? (string)$profile['handle'] : $handle;
                    if ($handle !== null && $handle !== '') {
                        $sess['handle'] = $handle;
                    }
                    $this->cacheUpsertProfile($pdo, $profile);
                }
            } catch (\Throwable $e) {
                // Non-fatal: OAuth session still works; UI will populate name later.
                Log::debug('[BSKY oauth callback] profile fetch failed: ' . $e->getMessage());
            }

            $this->authSessionUpsert($pdo, $c5UserId, $sess);
            $this->cacheAccountsUpsert(
                $pdo,
                (int)$c5UserId,
                (string)$did,
                $handle ? (string)$handle : null,
                $pds ? (string)$pds : null
            );
            $pdo->prepare('DELETE FROM oauth_states WHERE state = :s')->execute([':s' => $state]);

            $ok = true;
        } catch (\Throwable $e) {
            $err = $e->getMessage();
            Log::error('[BSKY oauth callback] ' . $err);
        }

        $payload = json_encode([
            'type' => 'bsky-oauth-complete',
            'ok' => $ok,
            'did' => $did,
            'handle' => $handle,
            'error' => $err,
        ], JSON_UNESCAPED_SLASHES);

        $html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Bluesky OAuth</title></head><body style=\"font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:16px;background:#0b0d10;color:#fff\">";
        if ($ok) {
            $html .= "<div>Connected. You can close this window.</div>";
        } else {
            $html .= "<div style=\"color:#f88\">Connect failed: " . htmlspecialchars((string)$err, ENT_QUOTES) . "</div>";
        }
        $html .= "<script>(function(){try{if(window.opener){window.opener.postMessage($payload,'*');}}catch(e){};try{window.close();}catch(e){}})();</script>";
        $html .= "</body></html>";

        return new Response($html, 200, ['Content-Type' => 'text/html; charset=utf-8']);
    }
}
