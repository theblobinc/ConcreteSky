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
  <div id="blueskyfeed">
    <div class="bsky-tabs" data-bsky-tabs data-bsky-locked="1">
      <bsky-profile>
        <div slot="taskbar" class="tabsbar" role="toolbar" aria-label="Bluesky Feed Views">
          <div class="tablist">
            <button class="tab" type="button" aria-pressed="true" data-tab="posts">Posts</button>
            <button class="tab" type="button" aria-pressed="false" data-tab="connections">Connections</button>
            <button class="tab" type="button" aria-pressed="false" data-tab="search">Search</button>
            <button class="tab" id="bsky-reset-layout" type="button" aria-pressed="false" style="cursor:pointer">Reset layout</button>
            <span class="tabhint">Tip: click multiple tabs to compare in columns.</span>
          </div>
        </div>
      </bsky-profile>

      <div class="panels">
        <section class="panel" data-panel="posts">
          <div data-bsky-mount="posts"></div>
        </section>

        <section class="panel" data-panel="connections" hidden>
          <div data-bsky-mount="connections"></div>
        </section>

        <section class="panel" data-panel="search" hidden>
          <div data-bsky-mount="search"></div>
        </section>
      </div>
    </div>

    <bsky-notification-bar></bsky-notification-bar>
  </div>
</div>

<script>
  // Hand off CSRF + API path to the JS layer
  window.BSKY = {
    csrf: '<?= h($csrfToken) ?>',
    apiPath: '<?= h($apiPath) ?>',
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
<script type="module" src="<?= BASE_URL ?>/packages/concretesky/js/main.js"></script>

<style>
  /* 1) Remove the default horizontal padding of this one container-fluid,
        so our inner #blueskyfeed can truly span the viewport. */
  .bsky-fluid {
    padding-left: 0;
    padding-right: 0;
    margin: 0;
    max-width: 100vw;
    width: 100vw;
    position: relative;
    left: 50%;
    margin-left: -50vw;
    margin-right: -50vw;
    background:#000;
    overflow-x:hidden;
  }

  /* 2) Make #blueskyfeed "bleed" to the viewport width (95vw) even though
        we're nested inside Concrete's grid. The calc() recenters the box
        relative to the viewport, not the parent container. */
  #blueskyfeed{
    background:#000;
    color:#fff;
    width:100%;
    max-width:100%;
    margin:0;
    border:0;
    border-radius:0;
    overflow-x:hidden;

    /* Gentle inner padding that scales with viewport without causing horiz scroll */
    padding-left: clamp(12px, 2vw, 24px);
    padding-right: clamp(12px, 2vw, 24px);

    /* Avoid unwanted top padding; components control vertical rhythm. */
    padding-top: 0;
  }

  /* 3) Tabs */
  .bsky-tabs{width:100%; background:#000}

  /* Hide the taskbar + panels until connected (JS clears data-bsky-locked). */
  .bsky-tabs[data-bsky-locked="1"] .tabsbar,
  .bsky-tabs[data-bsky-locked="1"] .panels{display:none;}
  .tabsbar{
    display:flex;
    gap:8px;
    flex-wrap:wrap;
    align-items:center;
    padding:8px;
    background:#0b0b0b;
    border:1px solid #222;
    border-radius:12px;
    position:relative;
    z-index:10;
  }
  .tablist{
    display:flex;
    gap:8px;
    flex-wrap:wrap;
    align-items:center;
    min-width:0;
    flex:1 1 auto;
  }
  .tab{
    appearance:none;
    background:#111;
    color:#fff;
    border:1px solid #333;
    border-radius:999px;
    padding:8px 12px;
    cursor:grab;
    font-weight:600;
  }
  .tab:active{cursor:grabbing}
  .tab[aria-pressed="true"]{
    background:#1d2a41;
    border-color:#2f4b7a;
  }
  .tab:focus{outline:2px solid #2f4b7a; outline-offset:2px}
  .tabhint{color:#aaa;font-size:.9rem;margin-left:auto;white-space:nowrap}

  .panels{
    margin-top:12px;
    display:flex;
    /* Keep panels on one row so resizing one shrinks adjacent panels instead of wrapping. */
    flex-wrap:nowrap;
    gap:16px;
    align-items:stretch;
    overflow-x:auto;
  }
  .panel{
    min-width:min(350px, 100%);
    flex: 1 1 350px;
    position:relative;
    background:#000; /* prevent theme white showing behind components */
    padding: 8px;
    box-sizing: border-box;
  }

  /* Posts panel: remove container padding so the component controls its own spacing */
  .panel[data-panel="posts"]{ padding:0; }

  /* resizer handle (injected by tabs.js) */
  .panel .resize-handle{
    position:absolute;
    top:10px;
    right:2px;
    bottom:10px;
    width:10px;
    cursor:col-resize;
    border-radius:8px;
    background:linear-gradient(to right, transparent, rgba(255,255,255,0.12));
    opacity:0.25;
  }
  .panel:hover .resize-handle{opacity:0.6}

  @media (max-width: 520px){
    /* Make the tabs bar a simple 2-column grid of buttons on mobile. */
    .tablist{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:8px;align-items:stretch}
    .tab{width:100%;cursor:pointer}
    .tabhint{grid-column:1/-1;margin-left:0;white-space:normal;display:block}
  }

  /* On smaller screens, allow panels to wrap naturally. */
  @media (max-width: 900px){
    .panels{flex-wrap:wrap; overflow-x:hidden;}
  }

  /* 4) Ensure all media inside our components scale to their column width. */
  #blueskyfeed img,
  #blueskyfeed video{ max-width:100%; height:auto; display:block }

  /* 5) Make custom elements fill their available width. */
  bsky-my-posts, bsky-followers, bsky-following, bsky-connections, bsky-people-search { display:block; width:100% }

  /* Match card minimum width expectations. */
  bsky-my-posts{min-width:min(350px, 100%)}

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
