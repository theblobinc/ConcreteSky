<?php
namespace Concrete\Package\Concretesky\Controller\SinglePage\Dashboard;

defined('C5_EXECUTE') or die('Access Denied.');

use Concrete\Core\Page\Controller\DashboardPageController;
use Concrete\Core\Routing\Redirect;

class Concretesky extends DashboardPageController
{
    public function view()
    {
        return Redirect::to('/dashboard/system/concretesky');
    }
}
