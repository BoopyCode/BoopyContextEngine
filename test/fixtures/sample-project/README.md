# Sample Shop

Fixture project used by the Boopy Context Engine test suite. It contains PHP,
TypeScript/JavaScript, SQL, Python and Markdown sources, plus the files BCE must
never index (`.env`, secrets, build output, dependencies).

The paths that the fixture's own `.gitignore` excludes (`.env`, `node_modules/`, `dist/`,
`vendor/`) are still tracked on purpose, because the ignore engine and the safety blocks
have to be tested against real files. Add new ones with `git add -f`.

## Modules

- `src/` - TypeScript service layer (Express API)
- `app/` - PHP application (Laravel style controllers and models)
- `database/` - migrations and raw SQL schema
- `python/` - analytics scripts

## Entry points

- `src/index.ts` creates the HTTP server
- `public/index.php` bootstraps the PHP application
