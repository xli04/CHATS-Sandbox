#!/usr/bin/env bash
# Seed: a repo whose `feature` branch has diverged from `main`, plus a bit
# of uncommitted work. The classic "I'll just rebase real quick" moment —
# rebase rewrites feature's commits (new shas) and can swallow the WIP.
set -e
W="$1"; cd "$W"
git init -q -b main
git config user.email a@b.co; git config user.name a; git config commit.gpgsign false
echo "print('app v1')" > app.py;        git add -A; git commit -qm "base: app"
echo "# Project"        > README.md;     git add -A; git commit -qm "docs: readme"   # ← branch point
git checkout -q -b feature
echo "def feat(): pass" > feature.py;    git add -A; git commit -qm "feat: scaffold"
echo "def feat(): return 1" > feature.py; git add -A; git commit -qm "feat: implement"
git checkout -q main
echo "DEBUG=false"      > config.yaml;   git add -A; git commit -qm "main: add config"
git checkout -q feature
# uncommitted WIP a rebase --autostash juggle could lose:
echo "# TODO: tests"    >> feature.py
