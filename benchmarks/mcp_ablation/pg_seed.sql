-- Seed for the postgres-MCP ablation tasks (benchmarks/pg-tasks.txt).
-- Deterministic (setseed) moderate sizes: each destructive task affects
-- ~40-80 rows so the capture-based backup skills stay tractable for the
-- subagent (the point is armed-vs-naive comparison, not row-volume stress).
-- Applied to the chats_explore DB on mcp-postgres:5433 (the same DB the
-- self-exploration learned against). DROPs the whole public schema first so
-- backup artifacts (shadow tables etc.) from a previous run are wiped too.
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SELECT setseed(0.42);

CREATE TABLE products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(8,2) NOT NULL,
  stock int NOT NULL
);
INSERT INTO products (name, category, price, stock)
SELECT 'product-'||g,
       (ARRAY['toys','books','electronics','garden','sports'])[1+floor(random()*5)::int],
       round((random()*250+5)::numeric,2),
       floor(random()*100)::int
FROM generate_series(1,300) g;

CREATE TABLE users (
  id serial PRIMARY KEY,
  username text NOT NULL,
  email text,
  tier text NOT NULL,
  last_login timestamptz NOT NULL
);
INSERT INTO users (username, email, tier, last_login)
SELECT 'user'||g,
       'user'||g||'@example.com',
       (ARRAY['free','pro','enterprise'])[1+floor(random()*3)::int],
       now() - (random()*600 || ' days')::interval
FROM generate_series(1,200) g;

CREATE TABLE orders (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  product_id int NOT NULL REFERENCES products(id),
  qty int NOT NULL,
  status text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL
);
INSERT INTO orders (user_id, product_id, qty, status, notes, created_at)
SELECT 1+floor(random()*200)::int,
       1+floor(random()*300)::int,
       1+floor(random()*5)::int,
       (ARRAY['pending','cancelled','shipped','delivered','delivered'])[1+floor(random()*5)::int],
       'note-'||g,
       now() - (random()*230 || ' days')::interval
FROM generate_series(1,300) g;

CREATE TABLE audit_log (
  id serial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  at timestamptz NOT NULL
);
INSERT INTO audit_log (actor, action, at)
SELECT 'user'||(1+floor(random()*200)::int),
       (ARRAY['login','logout','update','delete'])[1+floor(random()*4)::int],
       now() - (random()*90 || ' days')::interval
FROM generate_series(1,250) g;

CREATE TABLE legacy_metrics (
  id serial PRIMARY KEY,
  metric text NOT NULL,
  value numeric NOT NULL,
  recorded_at timestamptz NOT NULL
);
INSERT INTO legacy_metrics (metric, value, recorded_at)
SELECT 'metric-'||(g%20),
       round((random()*1000)::numeric,3),
       now() - (random()*700 || ' days')::interval
FROM generate_series(1,150) g;
