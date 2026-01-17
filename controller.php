<?php namespace Concrete\Package\Concretesky;

use Concrete\Core\Package\Package;
use Concrete\Core\Job\Job;
use Concrete\Core\Job\Set;
use Concrete\Core\Page\Single as SinglePage;

defined('C5_EXECUTE') or die('Access Denied.');

class Controller extends Package
{
    protected $pkgHandle = 'concretesky';
    protected $appVersionRequired = '9.0.0';
    protected $pkgVersion = '0.1.123';

    public function on_start()
    {
        // Register CLI-only commands.
        if (!\Concrete\Core\Application\Application::isRunThroughCommandLineInterface()) {
            return;
        }

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

        $this->installJobs($pkg);

        return $pkg;
    }

    public function upgrade()
    {
        parent::upgrade();
        $this->installJobs($this);
    }
}
