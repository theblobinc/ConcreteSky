<?php defined('C5_EXECUTE') or die('Access Denied.'); ?>

<div class="ccm-dashboard-header-buttons">
  <a class="btn btn-primary" href="<?= h((string)$view->url('/dashboard/concretesky/theme')) ?>">
    <?= t('Theme') ?>
  </a>
</div>

<h1><?= t('ConcreteSky') ?></h1>
<p class="lead"><?= t('Admin settings for the ConcreteSky SPA.') ?></p>

<ul>
  <li><a href="<?= h((string)$view->url('/dashboard/concretesky/theme')) ?>"><?= t('Theme') ?></a></li>
</ul>
