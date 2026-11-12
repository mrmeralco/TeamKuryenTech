"""Server-side guarantees the NFC Tap-to-Dashboard entry (/nfc) relies on.

The NFC card only holds an HTTPS navigation URL. The page resolves the workspace exclusively
from GET /api/account/workspaces for the verified Firebase user, then the dashboard calls the
normal role-checked Rentals endpoints. These tests pin that contract.
"""

from test_rentals_api import (  # noqa: F401  (pytest fixture re-export)
    OWNER, OWNER2, STAFF, STRANGER, TENANT, TENANT2, auth, base, env, invite_tenant, make_property, ok,
)


def memberships(client, headers):
    return ok(client.get("/api/account/workspaces", headers=headers))["rentalMemberships"]


def test_workspaces_requires_authentication(env):
    client, _, _ = env
    assert client.get("/api/account/workspaces").status_code == 401


def test_owner_resolves_to_own_property_with_pending_lifecycle_and_stays_restricted(env):
    client, _, _ = env
    pid = make_property(client, OWNER, activate=False)
    ok(client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER))
    [m] = memberships(client, OWNER)
    assert m["propertyId"] == pid and m["role"] == "owner" and m["unitId"] is None
    assert m["lifecycle"] == "pending_activation"
    # NFC routing does not bypass entitlement: subscription-gated reads stay blocked.
    assert client.get(f"{base(pid)}/analytics", headers=OWNER).status_code == 402
    # The owner cannot approve their own subscription or reach staff tools.
    assert ok(client.get("/api/platform/me", headers=OWNER))["platformAdmin"] is False
    assert client.get("/api/platform/subscriptions", headers=OWNER).status_code == 403
    assert client.post(f"/api/platform/subscriptions/{pid}/approve", headers=OWNER, json={"confirm": True}).status_code == 403


def test_tenant_resolves_to_assigned_unit_only_and_cannot_use_owner_or_staff_functions(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Unit 1"}), 201)
    invite_tenant(client, pid, unit["id"])
    [m] = memberships(client, TENANT)
    assert m == {"propertyId": pid, "propertyName": "Sunrise Apartments", "lifecycle": None,
                 "role": "tenant", "unitId": unit["id"], "unitLabel": "Unit 1"}
    assert ok(client.get(f"{base(pid)}/me/unit", headers=TENANT))["unitLabel"] == "Unit 1"
    for path in ("/units", "/subscription", "/audit-logs", "/members", "/utility-bills", "/statements", "/analytics"):
        assert client.get(f"{base(pid)}{path}", headers=TENANT).status_code == 403, path
    assert ok(client.get("/api/platform/me", headers=TENANT))["platformAdmin"] is False
    assert client.get("/api/platform/subscriptions", headers=TENANT).status_code == 403


def test_unaccepted_invitation_and_strangers_resolve_to_no_membership(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Unit 1"}), 201)
    ok(client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": unit["id"], "moveInDate": "2026-01-01"}), 201)
    assert memberships(client, TENANT) == []
    assert memberships(client, STRANGER) == []
    for headers in (TENANT, STRANGER):
        assert client.get(f"{base(pid)}/me/unit", headers=headers).status_code == 404


def test_removed_tenant_membership_is_no_longer_returned_or_authorized(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Unit 1"}), 201)
    invite_tenant(client, pid, unit["id"])
    assert len(memberships(client, TENANT)) == 1
    ok(client.post(f"{base(pid)}/members/tenant/revoke", headers=OWNER))
    assert memberships(client, TENANT) == []
    assert client.get(f"{base(pid)}/me/unit", headers=TENANT).status_code == 404
    assert client.get(f"{base(pid)}/me/statements", headers=TENANT).status_code in (403, 404)


def test_multiple_properties_are_all_returned_for_the_chooser_and_isolated(env):
    client, _, _ = env
    first = make_property(client, OWNER, name="Alpha Homes")
    second = make_property(client, OWNER, name="Beta Homes")
    other = make_property(client, OWNER2, name="Gamma Homes")
    ids = sorted(m["propertyId"] for m in memberships(client, OWNER))
    assert ids == sorted([first, second])
    assert other not in ids
    # Knowing another property's id (e.g. from a copied ?p= hint) grants nothing.
    assert client.get(base(other), headers=OWNER).status_code == 404


def test_same_card_two_accounts_get_their_own_role(env):
    client, _, _ = env
    pid = make_property(client)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Unit 1"}), 201)
    invite_tenant(client, pid, unit["id"])
    assert [m["role"] for m in memberships(client, OWNER)] == ["owner"]
    assert [m["role"] for m in memberships(client, TENANT)] == ["tenant"]
    assert memberships(client, TENANT2) == []


def test_platform_staff_claim_is_separate_from_rentals_membership(env):
    client, _, _ = env
    make_property(client, OWNER)
    assert ok(client.get("/api/platform/me", headers=STAFF))["platformAdmin"] is True
    assert memberships(client, STAFF) == []
    # An unverified/claimless copy of the staff uid gets no staff access.
    assert client.get("/api/platform/subscriptions", headers=auth("staff")).status_code == 403
