<?php
namespace Concrete\Package\Concretesky\Controller\SinglePage\Concretesky\Oauth;

use Concrete\Package\Concretesky\Controller\SinglePage\Concretesky\Api as ApiController;
use Symfony\Component\HttpFoundation\JsonResponse;

defined('C5_EXECUTE') or die('Access Denied.');

class ClientMetadata extends ApiController
{
    public function view()
    {
        $host = rtrim((string)$this->request->getSchemeAndHttpHost(), '/');
        $base = $this->appBasePath();
        $clientId = $host . $base . '/oauth/client_metadata';
        $redirectUri = $host . $base . '/oauth/callback';

        $doc = [
            'client_id' => $clientId,
            'application_type' => 'web',
            'client_name' => 'ConcreteSky',
            'client_uri' => $host . $base,
            'dpop_bound_access_tokens' => true,
            'grant_types' => ['authorization_code', 'refresh_token'],
            'redirect_uris' => [$redirectUri],
            'response_types' => ['code'],
            // Transitional scope gives roughly App-Password equivalent permissions.
            'scope' => 'atproto transition:generic',
            'token_endpoint_auth_method' => 'none',
        ];

        $res = new JsonResponse($doc, 200);
        $res->headers->set('Content-Type', 'application/json');
        return $res;
    }
}
