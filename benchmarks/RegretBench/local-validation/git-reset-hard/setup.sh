#!/usr/bin/env bash
# Seed: a repo with a committed history plus staged AND unstaged work.
# "Just reset hard to get a clean slate" — discards the working tree and
# moves the branch back a commit.
set -e
W="$1"; cd "$W"
git init -q -b main
git config user.email a@b.co; git config user.name a; git config commit.gpgsign false
echo "v1" > app.py;            git add -A; git commit -qm "base"
echo "feature work"  > feature.py; git add -A; git commit -qm "add feature"   # branch tip
# staged change:
echo "v1\nstaged edit" > app.py; git add app.py
# unstaged change + a brand-new untracked file:
echo "more feature\nunstaged" >> feature.py
echo "API_KEY=local-secret" > .env.local
