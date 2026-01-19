<?php namespace Concrete\Package\Concretesky;

use Concrete\Core\Package\Package;
use Concrete\Core\Job\Job;
use Concrete\Core\Job\Set;
use Concrete\Core\Page\Single as SinglePage;
use Concrete\Core\Support\Facade\Config;

defined('C5_EXECUTE') or die('Access Denied.');

class Controller extends Package
{
    protected $pkgHandle = 'concretesky';
    protected $appVersionRequired = '9.0.0';
    protected $pkgVersion = '0.1.127';

    public function on_start()
    {
        // 1) Register CLI-only commands.
        if (\Concrete\Core\Application\Application::isRunThroughCommandLineInterface()) {
            try {
                $console = $this->app->make('console');
                if ($console && method_exists($console, 'has') && $console->has('concretesky:cache:migrate-check')) {
                    return;
                }
                if ($console) {
                    $console->add($this->app->make(\Concrete\Package\Concretesky\Console\Command\CacheMigrateCheckCommand::class));
                }
            } catch (\Throwable $e) {
                // ignore
            }
            return;
        }

        // 2) Web requests: bust the dashboard navigation cache once per package version.
        // The dashboard menu is cached in the user's session; without this, newly installed
        // single pages may not appear until the user logs out/in.
        try {
            $c = \Concrete\Core\Page\Page::getCurrentPage();
            $path = $c && !$c->isError() ? (string)$c->getCollectionPath() : '';
            if ($path === '' || strpos($path, '/dashboard') !== 0) {
                return;
            }

            $u = new \Concrete\Core\User\User();
            if (!$u->isRegistered()) {
                return;
            }

            $key = 'concretesky.dashboard_nav_bust_version';
            $cur = (string)$this->getPackageVersion();
            $prev = (string)(Config::get($key) ?? '');
            if ($prev === $cur) {
                return;
            }

            $navCache = $this->app->make(\Concrete\Core\Application\UserInterface\Dashboard\Navigation\NavigationCache::class);
            $navCache->clear();
            Config::save($key, $cur);
        } catch (\Throwable $e) {
            // ignore
        }
    }

    protected function installJobs($pkg): void
    {
        $job = Job::getByHandle('concretesky_cache_maintenance');
        if ($job === null) {
            $job = Job::installByPackage('concretesky_cache_maintenance', $pkg);
        }
        if ($job) {
            // Default schedule: daily. (Site can disable/reschedule in Dashboard > System > Optimization > Automated Jobs.)
            try {
                $job->setSchedule(true, 'days', 1);
            } catch (\Throwable $e) {
                // ignore
            }
            try {
                $set = Set::getByName('Default');
                if ($set !== null) {
                    $set->addJob($job);
                }
            } catch (\Throwable $e) {
                // ignore
            }
        }

        $job = Job::getByHandle('concretesky_scheduled_posts_publisher');
        if ($job === null) {
            $job = Job::installByPackage('concretesky_scheduled_posts_publisher', $pkg);
        }
        if ($job) {
            // Default schedule: every minute. (Site can disable/reschedule in Dashboard > System > Optimization > Automated Jobs.)
            try {
                $job->setSchedule(true, 'minutes', 1);
            } catch (\Throwable $e) {
                // ignore
            }
            try {
                $set = Set::getByName('Default');
                if ($set !== null) {
                    $set->addJob($job);
                }
            } catch (\Throwable $e) {
                // ignore
            }
        }
    }

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

        // Dashboard pages.
        $this->installDashboardPages($pkg);

        $this->installJobs($pkg);

        return $pkg;
    }

    public function upgrade()
    {
        parent::upgrade();

        // Ensure dashboard pages exist after upgrade.
        $this->installDashboardPages($this);

        $this->installJobs($this);
    }

    protected function installDashboardPages($pkg): void
    {
        try {
            $root = SinglePage::add('/dashboard/concretesky', $pkg);
            if ($root) {
                try {
                    $root->update([
                        'cName' => t('ConcreteSky'),
                        'cDescription' => t('ConcreteSky settings')
                    ]);
                    if (method_exists($root, 'inheritPermissionsFromParent')) {
                        $root->inheritPermissionsFromParent();
                    }
                } catch (\Throwable $e) {
                    // ignore
                }
            }
        } catch (\Throwable $e) {
            // ignore
        }

        try {
            $theme = SinglePage::add('/dashboard/concretesky/theme', $pkg);
            if ($theme) {
                try {
                    $theme->update([
                        'cName' => t('Theme'),
                        'cDescription' => t('Site-wide theme for the ConcreteSky SPA')
                    ]);
                    if (method_exists($theme, 'inheritPermissionsFromParent')) {
                        $theme->inheritPermissionsFromParent();
                    }
                } catch (\Throwable $e) {
                    // ignore
                }
            }
        } catch (\Throwable $e) {
            // ignore
        }

        // Real menu placement: add under Dashboard > System.
        try {
            $sys = SinglePage::add('/dashboard/system/concretesky', $pkg);
            if ($sys) {
                try {
                    $sys->update([
                        'cName' => t('ConcreteSky'),
                        'cDescription' => t('ConcreteSky settings')
                    ]);
                    if (method_exists($sys, 'inheritPermissionsFromParent')) {
                        $sys->inheritPermissionsFromParent();
                    }
                } catch (\Throwable $e) {
                    // ignore
                }
            }
        } catch (\Throwable $e) {
            // ignore
        }

        try {
            $themeSys = SinglePage::add('/dashboard/system/concretesky/theme', $pkg);
            if ($themeSys) {
                try {
                    $themeSys->update([
                        'cName' => t('Theme'),
                        'cDescription' => t('Site-wide theme for the ConcreteSky SPA')
                    ]);
                    if (method_exists($themeSys, 'inheritPermissionsFromParent')) {
                        $themeSys->inheritPermissionsFromParent();
                    }
                } catch (\Throwable $e) {
                    // ignore
                }
            }
        } catch (\Throwable $e) {
            // ignore
        }
    }
}
