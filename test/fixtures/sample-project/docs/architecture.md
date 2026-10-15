# Architecture

The sample shop is split into an HTTP layer (`src/index.ts`), a service layer
(`src/services`), the PHP application (`app/`) and the database schema
(`database/`).

## Data flow

1. HTTP request hits `createServer()` in `src/index.ts`.
2. `OrderService` / `UserService` apply the business rules.
3. `database/schema.sql` and the Laravel migration define the tables.
4. `python/analytics` produces the reporting views.
