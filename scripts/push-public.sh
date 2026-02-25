#!/bin/bash
# Push clean snapshot to pando-lux/pando (origin)
# Uses orphan branch technique to avoid leaking old history with secrets
# Usage: bash scripts/push-public.sh "commit message"
#
# NOTE: This script stashes uncommitted changes, creates an orphan snapshot,
# pushes it, then restores your working directory.
# SAFE: Always cleans up even if push fails.

MSG="${1:-Update $(date -u +%Y-%m-%d)}"
BRANCH="__push-snapshot-$(date +%s)"
PUSH_RESULT=0

# Save any uncommitted changes
echo "Stashing uncommitted changes..."
git stash push -m "push-public-auto-stash" --include-untracked 2>/dev/null || true

echo "Creating clean snapshot..."
git checkout --orphan "$BRANCH" 2>/dev/null
git add -A
GIT_AUTHOR_NAME="pando-lux" GIT_AUTHOR_EMAIL="unlockpando@gmail.com" \
GIT_COMMITTER_NAME="pando-lux" GIT_COMMITTER_EMAIL="unlockpando@gmail.com" \
git commit -m "$MSG"

echo "Pushing to origin (pando-lux/pando)..."
git push origin "$BRANCH":master --force || PUSH_RESULT=$?

# ALWAYS clean up — even if push failed
echo "Cleaning up..."
git checkout master
git branch -D "$BRANCH" 2>/dev/null || true

# Restore stashed changes
echo "Restoring working directory..."
git stash pop 2>/dev/null || true

if [ $PUSH_RESULT -ne 0 ]; then
  echo "ERROR: Push failed (exit code $PUSH_RESULT). Working directory restored."
  exit $PUSH_RESULT
fi

echo "Done. pando-lux/pando updated."
