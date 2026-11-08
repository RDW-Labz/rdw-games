#!/bin/sh
# Refuse any staged file over 50 MB (decision #242). Installed as .git/hooks/pre-commit.
limit=52428800; bad=0
git diff --cached --name-only --diff-filter=AM -z | while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  s=$(wc -c < "$f"); if [ "$s" -gt "$limit" ]; then echo "refused: $f is $s bytes (> 50 MB)"; exit 1; fi
done || bad=1
exit $bad
