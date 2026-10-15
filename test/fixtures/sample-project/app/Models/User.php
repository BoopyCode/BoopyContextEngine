<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Eloquent model for the users table.
 */
class User extends Model
{
    protected $table = 'users';

    protected $fillable = ['email', 'name'];

    public function orders(): array
    {
        return [];
    }
}
