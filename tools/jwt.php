<?php
// Generate a ConcreteSky API JWT for MCP/automation.
// Usage:
//   php packages/concretesky/tools/jwt.php
//   php packages/concretesky/tools/jwt.php --user tbi
//   php packages/concretesky/tools/jwt.php --user tbi --ttl 3600
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

function usage(): void {
        $msg = <<<TXT
Generate a ConcreteSky API JWT for MCP/automation.

Usage:
    php packages/concretesky/tools/jwt.php [--user <username>] [--ttl <seconds>]

Notes:
    - <username> must be in CONCRETESKY_JWT_USERS (or CONCRETESKY_JWT_USER)
    - Default TTL comes from CONCRETESKY_JWT_TTL_SECONDS (min 60)
TXT;
        fwrite(STDERR, $msg . "\n");
}

$argv = $_SERVER['argv'] ?? [];
if (in_array('-h', $argv, true) || in_array('--help', $argv, true)) {
    usage();
    exit(0);
}

// Prefer the site root .env (same behavior as the controller).
// Fallbacks keep this tool usable when the package is run standalone.
$roots = [];
if (defined('DIR_BASE')) {
    $roots[] = (string)DIR_BASE;
}
// Typical ConcreteCMS structure: <site>/packages/<handle>/tools/jwt.php
$roots[] = dirname(__DIR__, 3);
// One more level up (fallback for alternative layouts).
$roots[] = dirname(__DIR__, 4);
// Package root fallback.
$roots[] = dirname(__DIR__, 2);

foreach ($roots as $root) {
    if (!is_string($root) || $root === '') continue;
    loadDotEnvOnce($root);
}

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

$wantUser = null;
$wantTtl = null;
for ($i = 1; $i < count($argv); $i++) {
    $a = (string)$argv[$i];
    if ($a === '-h' || $a === '--help') {
        usage();
        exit(0);
    }
    if ($a === '--user' || $a === '-u') {
        $wantUser = isset($argv[$i + 1]) ? (string)$argv[++$i] : '';
        continue;
    }
    if (str_starts_with($a, '--user=')) {
        $wantUser = substr($a, strlen('--user='));
        continue;
    }
    if ($a === '--ttl') {
        $wantTtl = isset($argv[$i + 1]) ? (string)$argv[++$i] : '';
        continue;
    }
    if (str_starts_with($a, '--ttl=')) {
        $wantTtl = substr($a, strlen('--ttl='));
        continue;
    }
    // Back-compat: allow passing username as a single positional arg.
    if ($a !== '') {
        $wantUser = $wantUser ?? $a;
        continue;
    }
}

$sub = $users[0];
if (is_string($wantUser) && trim($wantUser) !== '') {
    $candidate = trim($wantUser);
    if (!in_array($candidate, $users, true)) {
        fwrite(STDERR, "Requested user is not in CONCRETESKY_JWT_USERS: {$candidate}\n");
        exit(2);
    }
    $sub = $candidate;
}

$ttl = (int)trim(envStr('CONCRETESKY_JWT_TTL_SECONDS', '86400'));
if (is_string($wantTtl) && trim($wantTtl) !== '') {
    $ttl = (int)trim($wantTtl);
}
if ($ttl < 60) $ttl = 60;

$now = time();
$claims = [
    'iss' => 'concretesky',
    'sub' => $sub,
    'iat' => $now,
    'exp' => $now + $ttl,
];

echo jwtEncodeHs256($claims, $secret) . "\n";
