#!/usr/bin/env bash
# READ-ONLY inspection of the SmartWatts Firebase project. Changes nothing.
# Requires an interactive login first:  npx firebase login
set -euo pipefail
PROJECT="${1:-smartwatts-266cc}"
FB="npx firebase"

echo "== Logged-in account(s)";        $FB login:list
echo "== Can this account see $PROJECT?"; $FB projects:list | grep -E "Project ID|$PROJECT" || { echo "NOT VISIBLE: this account has no access to $PROJECT"; exit 1; }
echo "== Registered apps";             $FB apps:list --project "$PROJECT"
echo "== Firestore databases (ID, region, mode)"; $FB firestore:databases:list --project "$PROJECT"
echo "== Deployed Firestore indexes (compare with firestore.indexes.json)"; $FB firestore:indexes --project "$PROJECT"
echo "== Dry-run of the proposed deployment (validates rules, deploys nothing)"
$FB deploy --only firestore:rules,firestore:indexes,storage --project "$PROJECT" --dry-run || echo "Dry run reported a problem (see above)."
echo
echo "Not available from the CLI — check in the console:"
echo "  - Authentication > Sign-in method (Anonymous, Email/Password, Google)"
echo "  - Firestore > Data (existing collections) and Firestore > Rules (currently deployed rules)"
echo "  - Storage (whether a bucket exists)"
