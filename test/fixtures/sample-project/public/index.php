<?php

require __DIR__ . '/../vendor/autoload.php';

$app = new Illuminate\Foundation\Application();
echo $app->version();
