#!/usr/bin/env bash
# Build, test and publish the site to the gh-pages branch (GitHub Pages serves it from there).
# Needs no special token scope. Run from anywhere:  ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
npm test --silent
npm run build --silent
remote="$(git remote get-url origin)"
tmp="$(mktemp -d)"
cp -R dist/. "$tmp"
touch "$tmp/.nojekyll"
(
  cd "$tmp"
  git init -q -b gh-pages
  git add -A
  git -c user.name="deploy" -c user.email="deploy@localhost" commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%MZ) from $(git -C - rev-parse --short HEAD 2>/dev/null || echo local)"
  git push -q -f "$remote" gh-pages
)
rm -rf "$tmp"
echo "Published. It can take a minute to appear."
