<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Handles user related HTTP requests.
 */
final class UserController
{
    public function __construct(private readonly User $users)
    {
    }

    public function show(Request $request, int $id): JsonResponse
    {
        $user = $this->users->findOrFail($id);

        return response()->json(['id' => $user->id, 'email' => $user->email]);
    }

    public function store(Request $request): JsonResponse
    {
        $user = $this->users->create($request->only('email', 'name'));

        return response()->json($user, 201);
    }

    private function authorize(Request $request): bool
    {
        return $request->user() !== null;
    }
}
