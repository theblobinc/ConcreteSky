<?php namespace Concrete\Package\Concretesky;

use Concrete\Core\Package\Package;
use Concrete\Core\Page\Single as SinglePage;

defined('C5_EXECUTE') or die('Access Denied.');

class Controller extends Package
{
    protected $pkgHandle = 'concretesky';
    protected $appVersionRequired = '9.0.0';
    protected $pkgVersion = '0.1.40';

    public function getPackageName()
    {
        return t('ConcreteSky');
    }

    public function getPackageDescription()
    {
        return t('ConcreteSky: Bluesky dashboard (SQLite cache + OAuth) for TheBlobInc.');
    }

    public function install()
    {
        $pkg = parent::install();

        // Main single page + child endpoints.
        // Note: OAuth requires that /concretesky/oauth/client_metadata is publicly viewable.
        SinglePage::add('/concretesky', $pkg);
        SinglePage::add('/concretesky/api', $pkg);
        SinglePage::add('/concretesky/oauth/callback', $pkg);
        SinglePage::add('/concretesky/oauth/client_metadata', $pkg);

        return $pkg;
    }
}
