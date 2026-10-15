-- Raw schema used by the analytics jobs.
CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    total_cents INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_id_idx ON orders (user_id);

CREATE VIEW paid_orders AS
    SELECT id, user_id, total_cents FROM orders WHERE status = 'paid';

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'refunded');
