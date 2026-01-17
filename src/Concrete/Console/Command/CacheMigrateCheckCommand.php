<?php
namespace Concrete\Package\Concretesky\Console\Command;

use Concrete\Core\Console\Command;
use Concrete\Core\Support\Facade\Facade;
use Concrete\Package\Concretesky\Controller\SinglePage\Concretesky\Api as ApiController;
use PDO;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class CacheMigrateCheckCommand extends Command
{
    protected function configure()
    {
        $okExitCode = static::SUCCESS;
        $errExitCode = static::FAILURE;

        $this
            ->setName('concretesky:cache:migrate-check')
            ->setDescription('Run ConcreteSky cache.sqlite migrations and verify expected schema version.')
            ->addEnvOption()
            ->setHelp(<<<EOT
Runs cache DB migrations (if needed) and then verifies that the stored schema version matches the expected version.

Returns codes:
  $okExitCode operation completed successfully
  $errExitCode errors occurred / schema mismatch
EOT
            )
        ;
    }

    protected function execute(InputInterface $input, OutputInterface $output)
    {
        if (!class_exists(ApiController::class)) {
            $output->writeln('<error>ConcreteSky API controller not found (autoload failed?)</error>');
            return static::FAILURE;
        }

        $app = Facade::getFacadeApplication();

        try {
            /** @var ApiController $api */
            $api = $app->make(ApiController::class);
        } catch (\Throwable $e) {
            $output->writeln('<error>Failed to instantiate ConcreteSky API controller: ' . $e->getMessage() . '</error>');
            return static::FAILURE;
        }

        try {
            $ref = new \ReflectionClass($api);
            $expected = (string)$ref->getConstant('CACHE_SCHEMA_VERSION');

            $migrate = new \ReflectionMethod($api, 'cacheMigrate');
            $migrate->setAccessible(true);

            $cacheDb = new \ReflectionMethod($api, 'cacheDb');
            $cacheDb->setAccessible(true);

            $cacheDbPath = new \ReflectionMethod($api, 'cacheDbPath');
            $cacheDbPath->setAccessible(true);

            $metaGet = new \ReflectionMethod($api, 'cacheMetaGet');
            $metaGet->setAccessible(true);

            /** @var PDO $pdo */
            $pdo = $cacheDb->invoke($api);
            $path = (string)$cacheDbPath->invoke($api);

            $output->writeln('<info>DB</info>: ' . $path);

            $migrate->invoke($api, $pdo);

            $current = $metaGet->invoke($api, $pdo, null, 'schema_version');
            $current = $current !== null ? (string)$current : '';

            $output->writeln('<info>Schema</info>: ' . ($current ?: '—') . ' (expected ' . ($expected ?: '—') . ')');

            if ($expected === '' || $current === '') {
                $output->writeln('<error>Schema version missing (expected/current empty).</error>');
                return static::FAILURE;
            }

            if ($current !== $expected) {
                $output->writeln('<error>Schema mismatch.</error>');
                return static::FAILURE;
            }

            $output->writeln('<info>OK</info>: cache schema matches expected.');
            return static::SUCCESS;
        } catch (\Throwable $e) {
            $output->writeln('<error>Failed: ' . $e->getMessage() . '</error>');
            return static::FAILURE;
        }
    }
}
