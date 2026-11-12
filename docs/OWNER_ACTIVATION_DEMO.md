# Owner activation audit and demo procedure

Live account UID, selected property, membership, subscription and record counts are UNVERIFIED. No authenticated browser session or live database query was used in this audit. The reported pending status is user-supplied evidence, not a confirmed database read. Missing analytics does not establish missing/deleted records.

## Read-only account check
In the authenticated Owner workspace, confirm the property identifier in the workspace/API response. GET /api/account/workspaces returns only the caller's memberships. GET /api/rentals/properties/{pid} provides role/setup/entitlement. Count authorized responses from /units, /meters, /readings, /utility-bills and /statements without copying record contents. Personal bills are stored separately under the authenticated user's personal data path; inspect them in the Personal workspace. Do not mix those bills into Rentals analytics.

## Staff approval (requires explicit approval)
1. Sign in using an existing authorized staff account with a backend-verified platformAdmin claim.
2. Open Platform > Rentals subscriptions, filter Pending activation, match the property ID and owner UID, and choose Review.
3. Verify the request and current status. Select Approve only after the demo activation has been authorized.
4. Choose External payment verified and enter the actual verified payment reference, or choose Administrative grant and enter the explicit grant reason. Never invent payment evidence.
5. Enter the approved entitlement end date, review the confirmation, then submit. The backend validates the action, expected version, source/reason/reference and entitlement period, and creates subscription/audit events.
6. Refresh the Owner Subscription page; verify active status and entitlement dates. Analytics must still reject inactive entitlements. A rejected request returns the owner to the request workflow with its reason.

### Provisioning the separate SmartWatts staff account

Use `scripts/provision-platform-admin.py` with authorized ADC. `--dry-run` and `--verify` perform read-only checks; `--grant` and `--revoke` require an interactive exact-target confirmation. The tool is pinned to the dedicated staff email/UID and project, checks enabled/verified identity, preserves unrelated claims, and verifies a completed write. Never provision the Owner or Tenant. Follow `docs/FIREBASE_SETUP.md` for minimum Auth permissions and commands. Once provisioned, sign out/in as staff, refresh the ID token, and check `GET /api/platform/me` before opening Platform → Rentals subscriptions.

## Isolated NFC rehearsal
Use demo-smartwatts Firebase emulators and clearly labeled synthetic fixtures. Verify owner membership, tenant invitation acceptance and assigned unit. Request and approve an isolated synthetic entitlement with an existing synthetic staff claim. Save readings/bills in Rentals, verify them on their corresponding pages and Analytics, and verify Personal bills stay separate. Check tenant denial for owner-only routes and cross-property access. Confirm the NFC entry is fully implemented and deployed before programming a card; current domain, physical cards and phone behavior are not verified here. Program only an HTTPS navigation URL with no account identifiers or credentials. No production account creation, membership edits, subscriptions or data population are authorized by this procedure.
