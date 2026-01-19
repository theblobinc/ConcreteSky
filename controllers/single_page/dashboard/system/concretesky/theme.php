<?php
namespace Concrete\Package\Concretesky\Controller\SinglePage\Dashboard\System\Concretesky;

defined('C5_EXECUTE') or die('Access Denied.');

use Concrete\Core\Page\Controller\DashboardPageController;
use Concrete\Core\Support\Facade\Config;

class Theme extends DashboardPageController
{
    private const SAVE_TOKEN = 'concretesky_theme_save';
    private const CONFIG_KEY = 'concretesky.theme_json';

    public function on_start()
    {
        if (is_callable('parent::on_start')) {
            parent::on_start();
        }

        $this->set('csrfToken', $this->app->make('token')->generate(self::SAVE_TOKEN));
        $this->set('initialTheme', $this->loadThemeFromConfig());
    }

    public function view()
    {
        // View mounts the editor.
    }

    public function save()
    {
        $this->checkCSRFToken();

        $raw = (string)($this->request->request->get('theme_json') ?? '');
        $theme = $this->normalizeThemeJson($raw);

        if ($theme === null) {
            return $this->json(['ok' => false, 'error' => 'Invalid theme JSON'], 400);
        }

        Config::save(self::CONFIG_KEY, json_encode($theme, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

        return $this->json(['ok' => true, 'theme' => $theme]);
    }

    private function checkCSRFToken(): void
    {
        $token = (string)($this->request->request->get('ccm_token') ?? '');
        $valt = $this->app->make('token');
        if (!$valt->validate(self::SAVE_TOKEN, $token)) {
            throw new \Exception(t('Invalid CSRF token. Please reload and try again.'));
        }
    }

    private function json($data, int $status = 200)
    {
        $res = new \Symfony\Component\HttpFoundation\JsonResponse($data, $status);
        $res->send();
        exit;
    }

    private function loadThemeFromConfig(): array
    {
        try {
            $raw = (string)(Config::get(self::CONFIG_KEY) ?? '');
            if (!$raw) return ['preset' => 'dark', 'vars' => (object)[], 'prefs' => (object)[]];
            $decoded = json_decode($raw, true);
            $normalized = $this->normalizeThemeArray(is_array($decoded) ? $decoded : null);
            return $normalized ?? ['preset' => 'dark', 'vars' => (object)[], 'prefs' => (object)[]];
        } catch (\Throwable $e) {
            return ['preset' => 'dark', 'vars' => (object)[], 'prefs' => (object)[]];
        }
    }

    private function normalizeThemeJson(string $raw): ?array
    {
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) return null;
        return $this->normalizeThemeArray($decoded);
    }

    private function normalizeThemeArray(?array $decoded): ?array
    {
        if (!$decoded) return ['preset' => 'dark', 'vars' => (object)[], 'prefs' => (object)[]];

        $preset = $decoded['preset'] ?? 'dark';
        $preset = ($preset === 'light' || $preset === 'dark') ? $preset : 'dark';

        $varsIn = $decoded['vars'] ?? [];
        if (!is_array($varsIn)) $varsIn = [];

        $vars = [];
        foreach ($varsIn as $k => $v) {
            $key = trim((string)$k);
            if ($key === '' || strpos($key, '--') !== 0) continue;
            if (strpos($key, '--bsky-') !== 0) continue;

            $val = trim((string)$v);
            if ($val === '') continue;
            if (strlen($val) > 200) continue;

            $vars[$key] = $val;
        }

        $prefsIn = $decoded['prefs'] ?? [];
        if (!is_array($prefsIn)) $prefsIn = [];

        $prefs = [];
        $motion = (string)($prefsIn['motion'] ?? '');
        $motion = trim($motion);
        if ($motion === 'system' || $motion === 'reduce' || $motion === 'full') {
            $prefs['motion'] = $motion;
        }

        $density = (string)($prefsIn['density'] ?? '');
        $density = trim($density);
        if ($density === 'compact' || $density === 'comfortable') {
            $prefs['density'] = $density;
        }

        $fontSize = (string)($prefsIn['fontSize'] ?? '');
        $fontSize = trim($fontSize);
        if ($fontSize === 'sm' || $fontSize === 'md' || $fontSize === 'lg') {
            $prefs['fontSize'] = $fontSize;
        }

        return ['preset' => $preset, 'vars' => (object)$vars, 'prefs' => (object)$prefs];
    }
}
