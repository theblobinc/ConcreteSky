<?php defined('C5_EXECUTE') or die('Access Denied.'); ?>
<?php
$enableJS = true;
$u = new \Concrete\Core\User\User();
$c = \Concrete\Core\Page\Page::getCurrentPage();
if ($u->isRegistered() && $c->isEditMode()) { $enableJS = false; }

$c5UserId = (int)$u->getUserID();
$c5UserName = $u->isRegistered() ? (string)$u->getUserName() : 'Guest';

use Concrete\Core\Page\Page;
// Resolve the current URL of the API page even if this single page is moved.
// Prefer "<current page>/api" then fall back to known locations.
$currentPath = '';
try {
  $currentPath = (string)$c->getCollectionPath();
} catch (\Throwable $e) { /* ignore */ }

$apiPath = '';
$candidatePaths = [];
if ($currentPath) {
  $candidatePaths[] = rtrim($currentPath, '/') . '/api';
}
$candidatePaths[] = '/concretesky/api';
$candidatePaths[] = '/test/concretesky/api';

foreach ($candidatePaths as $p) {
  $apiPage = Page::getByPath($p);
  if ($apiPage && !$apiPage->isError()) {
    $apiPath = (string)$apiPage->getCollectionLink();
    break;
  }
}

if (!$apiPath) {
  // Last resort.
  $apiPath = (string)\Concrete\Core\Support\Facade\Url::to('/concretesky/api');
}

// Cache-bust ES module imports using the installed package version.
// (Browser module caches can be very sticky; version bumps already happen on deploy.)
$pkgVersion = '';
try {
  $pkg = \Concrete\Core\Package\Package::getByHandle('concretesky');
  if ($pkg) $pkgVersion = (string)$pkg->getPackageVersion();
} catch (\Throwable $e) { /* ignore */ }

// Site-wide theme (stored server-side).
$siteTheme = null;
try {
  $rawTheme = (string)(\Concrete\Core\Support\Facade\Config::get('concretesky.theme_json') ?? '');
  if ($rawTheme !== '') {
    $decoded = json_decode($rawTheme, true);
    if (is_array($decoded)) $siteTheme = $decoded;
  }
} catch (\Throwable $e) { /* ignore */ }
?>
<section>
  <?php
  // Keep Concrete's editable "Main" area intact for the page
  $a = new \Concrete\Core\Area\Area('Main');
  $a->setAreaGridMaximumColumns(12);
  $a->enableGridContainer();
  $a->display($c);
  ?>
</section>

<?php if ($enableJS): ?>
<!-- Use container-fluid to avoid the theme's fixed-width container.
     Add a custom class (bsky-fluid) so we can remove its side padding just here. -->
<div class="container-fluid bsky-fluid">
  <bsky-app></bsky-app>
</div>

<script>
  // Hand off CSRF + API path to the JS layer
  window.BSKY = {
    csrf: '<?= h($csrfToken) ?>',
    apiPath: '<?= h($apiPath) ?>',
    siteTheme: <?= json_encode($siteTheme, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
    c5User: {
      id: <?= (int)$c5UserId ?>,
      name: '<?= h($c5UserName) ?>',
      registered: <?= $u->isRegistered() ? 'true' : 'false' ?>
    }
  };
</script>

<!-- Drag/drop tab ordering (used by tabs.js if available) -->
<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js" defer></script>

<!-- ES module entry; imports all web components -->
<script type="module" src="<?= BASE_URL ?>/packages/concretesky/js/main.js?v=<?= h($pkgVersion ?: 'dev') ?>"></script>

<style>
  /* 1) Remove the default horizontal padding of this one container-fluid,
        so our inner #blueskyfeed can truly span the viewport. */
  .bsky-fluid {
    padding-left: 15px;
    padding-right: 0;
    margin: 0;
    max-width: 98vw;
    width: 98vw;
    position: relative;
    left: 50%;
    margin-left: -50vw;
    margin-right: -50vw;
    background: var(--bsky-bg, #000);
    color: var(--bsky-fg, #fff);
    overflow-x:hidden;
  }

  /* App host is responsible for its own layout + styling (shadow DOM).
     Keep the Concrete-specific viewport hack here only. */
  bsky-app{display:block;width:100%}

  /* 6) Hide ConcreteCMS "page versions" notices on this tool page.
        (These can appear for admins and are noisy for this SPA.) */
  .ccm-ui .ccm-notification,
  .ccm-ui .ccm-alert,
  .ccm-ui .ccm-page-alert,
  .ccm-page-alert,
  .ccm-version-comments,
  .ccm-page-version,
  .ccm-page-version-list,
  .ccm-page-version-approve,
  .ccm-page-version-approve-message {
    display:none !important;
  }
</style>
<?php endif; ?>
