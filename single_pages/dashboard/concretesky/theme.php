<?php defined('C5_EXECUTE') or die('Access Denied.'); ?>
<?php
// Cache-bust ES module imports using the installed package version.
$pkgVersion = '';
try {
  $pkg = \Concrete\Core\Package\Package::getByHandle('concretesky');
  if ($pkg) $pkgVersion = (string)$pkg->getPackageVersion();
} catch (\Throwable $e) { /* ignore */ }
?>

<div class="ccm-dashboard-header-buttons">
  <button class="btn btn-secondary" type="button" onclick="window.location.reload()"><?= t('Reload') ?></button>
</div>

<h1><?= t('ConcreteSky Theme') ?></h1>
<p class="lead"><?= t('Set the site-wide default theme for the ConcreteSky SPA (stored server-side).') ?></p>

<div class="ccm-dashboard-form">
  <bsky-theme-panel data-storage="server"></bsky-theme-panel>
</div>

<script>
  // Provide server-side theme + save endpoint to the web component.
  window.BSKY = window.BSKY || {};
  window.BSKY.themeAdmin = {
    saveUrl: '<?= h((string)$view->action('save')) ?>',
    token: '<?= h((string)$csrfToken) ?>',
    initialTheme: <?= json_encode($initialTheme, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
    disableLocalStorage: true
  };

  // Also provide a siteTheme baseline so the app theme bootstrap can apply it.
  window.BSKY.siteTheme = window.BSKY.themeAdmin.initialTheme;
</script>

<script type="module" src="<?= BASE_URL ?>/packages/concretesky/js/dashboard/theme_admin.js?v=<?= h($pkgVersion ?: 'dev') ?>"></script>
