# mock-forum

A tiny Reddit-style forum used as a Postmill stand-in for the
CHATS-Sandbox remote-services benchmark. Single Flask app, SQLite
backend, plain HTML forms (no JS), pre-seeded with test data.

## Run

```bash
cd benchmarks/mock-forum
docker compose up --build
# → http://localhost:8080
```

To reset state between benchmark runs:

```bash
docker compose down -v   # -v drops the SQLite volume
docker compose up --build
```

## Test credentials

| username                | password   |
|-------------------------|------------|
| `MarvelsGrantMan136`    | `test1234` |
| `alex_dev`              | `test1234` |
| `rita_writes`           | `test1234` |

Forums: `general`, `tech`, `news`, `books`, `test`.

## URL shape (matches Postmill)

| Path                                 | What                              |
|--------------------------------------|-----------------------------------|
| `/`                                  | All posts                         |
| `/login`                             | Login form                        |
| `/submit`                            | Create new post                   |
| `/post/<id>`                         | Post detail + comments            |
| `/post/<id>/edit`                    | Edit own post                     |
| `/post/<id>/delete`     (POST)       | Delete own post                   |
| `/post/<id>/vote`       (POST)       | Toggle up/downvote                |
| `/post/<id>/comment`    (POST)       | Add comment                       |
| `/comment/<id>/delete`  (POST)       | Delete own comment                |
| `/user/<name>`                       | User profile (= submissions)      |
| `/user/<name>/submissions`           | User's posts                      |
| `/user/<name>/comments`              | User's comments                   |
| `/account`                           | Edit bio                          |
| `/forums`                            | List forums + subscribe buttons   |
| `/f/<name>`                          | Posts in a forum                  |
| `/f/<name>/subscribe`   (POST)       | Toggle subscription               |
| `/logout`               (POST)       | Clear session                     |

## Use with the benchmark

Set `SITE=http://localhost:8080` in `run_remote.sh` and the existing
prompts work as-is — the URL shape mirrors Postmill.

## Limitations

- No CSRF tokens (it's a benchmark target, not production).
- No password hashing (the seed user's password is in plaintext in SQLite).
- Score doesn't paginate; first 50 posts on the index.
- No image / media uploads.
