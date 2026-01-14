<?php
// Generate a ConcreteSky API JWT for MCP/automation.
// Usage:
//   php packages/concretesky/tools/jwt.php
//   CONCRETESKY_JWT_USERS=tbi php packages/concretesky/tools/jwt.php

declare(strict_types=1);

function loadDotEnvOnce(string $root): void {
    static $loaded = false;
    if ($loaded) return;
    $loaded = true;

    $path = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . '.env';
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

        if ((str_starts_with($val, '"') && str_ends_with($val, '"')) || (str_starts_with($val, "'") && str_ends_with($val, "'"))) {
            $val = substr($val, 1, -1);
        }

        if (getenv($key) !== false) continue;

        @putenv($key . '=' . $val);
        $_ENV[$key] = $val;
        $_SERVER[$key] = $val;
    }
}

function envStr(string $key, string $default = ''): string {
    $v = getenv($key);
    return $v === false ? $default : (string)$v;
}

function base64UrlEncode(string $bin): string {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function jwtSignHs256(string $data, string $secret): string {
    return hash_hmac('sha256', $data, $secret, true);
}

function jwtEncodeHs256(array $claims, string $secret): string {
    $hdr = ['alg' => 'HS256', 'typ' => 'JWT'];
    $h = base64UrlEncode(json_encode($hdr, JSON_UNESCAPED_SLASHES));
    $p = base64UrlEncode(json_encode($claims, JSON_UNESCAPED_SLASHES));
    $sig = base64UrlEncode(jwtSignHs256($h . '.' . $p, $secret));
    return $h . '.' . $p . '.' . $sig;
}

$root = dirname(__DIR__, 2);
loadDotEnvOnce($root);

$secret = trim(envStr('CONCRETESKY_JWT_SECRET', ''));
if ($secret === '') {
    fwrite(STDERR, "Missing CONCRETESKY_JWT_SECRET in .env\n");
    exit(2);
}

$usersRaw = trim(envStr('CONCRETESKY_JWT_USERS', ''));
if ($usersRaw === '') $usersRaw = trim(envStr('CONCRETESKY_JWT_USER', ''));
$users = array_values(array_filter(array_map('trim', explode(',', $usersRaw))));
if (!$users) {
    fwrite(STDERR, "Missing CONCRETESKY_JWT_USERS (or CONCRETESKY_JWT_USER) in .env\n");
    exit(2);
}

$sub = $users[0];
$ttl = (int)trim(envStr('CONCRETESKY_JWT_TTL_SECONDS', '86400'));
if ($ttl < 60) $ttl = 60;

$now = time();
$claims = [
    'iss' => 'concretesky',
    'sub' => $sub,
    'iat' => $now,
    'exp' => $now + $ttl,
];

echo jwtEncodeHs256($claims, $secret) . "\n";
