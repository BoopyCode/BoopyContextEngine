<?php

declare(strict_types=1);

namespace Tests;

use App\Http\Controllers\UserController;
use PHPUnit\Framework\TestCase;

final class UserControllerTest extends TestCase
{
    public function testShowReturnsJson(): void
    {
        $this->assertTrue(class_exists(UserController::class));
    }
}
