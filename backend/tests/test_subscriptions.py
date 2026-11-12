"""Platform-controlled Rentals subscription lifecycle: transitions, authorization, concurrency, audit."""

from datetime import timedelta

from test_rentals_api import (  # noqa: F401  (env is a pytest fixture)
    ANON, OWNER, OWNER2, STAFF, TENANT, activate_property, auth, base, env, invite_tenant, make_property, ok,
)

PLATFORM = "/api/platform/subscriptions"


def admin_view(client, pid):
    return ok(client.get(f"{PLATFORM}/{pid}", headers=STAFF))


def act(client, pid, action, headers=STAFF, **body):
    version = body.pop("expectedVersion", None)
    if version is None:
        version = admin_view(client, pid)["version"]
    return client.post(f"{PLATFORM}/{pid}/{action}", headers=headers, json={"confirm": True, "expectedVersion": version, **body})


def test_owner_requests_and_cannot_self_approve_or_forge_payment(env):
    client, _, _ = env
    pid = make_property(client, activate=False)
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["lifecycle"] == "draft"
    # Forged fields in the request body are ignored: a request never grants entitlement.
    forged = ok(client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER,
                            json={"status": "active", "paymentStatus": "paid", "currentPeriodEnd": "2027-12-31"}))
    assert forged["status"] == "pending_activation" and forged["active"] is False
    # Replayed request is rejected.
    assert client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER).status_code == 409
    # Owners, tenants, other owners, and anonymous users cannot use platform endpoints.
    for headers in (OWNER, OWNER2, TENANT, ANON):
        assert act(client, pid, "approve", headers=headers, expectedVersion=1, activationSource="administrative_grant",
                   reason="Self approval attempt", periodEnd="2026-11-30").status_code in (401, 403)
        assert client.get(PLATFORM, headers=headers).status_code in (401, 403)
    # A forged custom claim cannot be sent in the request body either.
    assert client.post(f"{PLATFORM}/{pid}/approve", headers=OWNER, json={"platformAdmin": True}).status_code == 403
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["active"] is False
    assert client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant"}).status_code in (402, 404)


def test_approval_requires_source_reference_period_and_confirmation(env):
    client, _, _ = env
    pid = make_property(client, activate=False)
    ok(client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER))
    version = admin_view(client, pid)["version"]
    base_body = {"expectedVersion": version, "periodEnd": "2026-11-30"}
    assert act(client, pid, "approve", **base_body).status_code == 422  # no source
    assert act(client, pid, "approve", activationSource="external_payment_verified", **base_body).status_code == 422  # no reference
    assert act(client, pid, "approve", activationSource="administrative_grant", **base_body).status_code == 422  # no reason
    assert act(client, pid, "approve", activationSource="administrative_grant", reason="Pilot grant approved", expectedVersion=version,
               periodEnd="2026-10-01").status_code == 422  # past
    assert act(client, pid, "approve", activationSource="administrative_grant", reason="Pilot grant approved", expectedVersion=version,
               periodEnd="2028-12-31").status_code == 422  # too long
    no_confirm = client.post(f"{PLATFORM}/{pid}/approve", headers=STAFF, json={
        "expectedVersion": version, "activationSource": "external_payment_verified", "paymentReference": "GCASH-REF-1234", "periodEnd": "2026-11-30"})
    assert no_confirm.status_code == 422
    approved = ok(act(client, pid, "approve", activationSource="external_payment_verified", paymentReference="GCASH-REF-1234", **base_body))
    assert approved["status"] == "active" and approved["activationSource"] == "external_payment_verified"
    assert approved["decidedBy"] == "staff" and approved["paymentReference"] == "GCASH-REF-1234"
    owner_view = ok(client.get(f"{base(pid)}/subscription", headers=OWNER))
    assert owner_view["active"] is True and owner_view["currentPeriodEnd"].startswith("2026-11-30")
    assert "paymentReference" not in owner_view


def test_reject_suspend_reactivate_expire_disable_restore(env):
    client, clock, _ = env
    pid = make_property(client, activate=False)
    ok(client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER))
    assert act(client, pid, "reject").status_code == 422  # reason required
    ok(act(client, pid, "reject", reason="Payment could not be matched to a receipt."))
    owner = ok(client.get(f"{base(pid)}/subscription", headers=OWNER))
    assert owner["lifecycle"] == "draft" and "could not be matched" in owner["statusReason"]
    assert owner["nextAction"]["action"] == "request"

    activate_property(client, pid)
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    assert act(client, pid, "approve", activationSource="administrative_grant", reason="Double approve attempt",
               periodEnd="2026-11-30").status_code == 409  # invalid transition
    ok(act(client, pid, "suspend", reason="Chargeback under investigation."))
    suspended = ok(client.get(f"{base(pid)}/subscription", headers=OWNER))
    assert suspended["lifecycle"] == "suspended" and suspended["active"] is False
    assert client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1B"}).status_code == 402
    assert client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": unit["id"]}).status_code == 402
    assert client.get(f"{base(pid)}/units", headers=OWNER).status_code == 200  # records stay readable
    assert client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER).status_code == 409
    # Reactivation keeps the still-valid paid period.
    reactivated = ok(act(client, pid, "reactivate", activationSource="administrative_grant", reason="Investigation closed in owner's favour."))
    assert reactivated["status"] == "active" and reactivated["currentPeriodEnd"].startswith("2026-11-15")
    # Extension cannot shorten, and needs a reason and source.
    assert act(client, pid, "extend", activationSource="administrative_grant", reason="Extension test", periodEnd="2026-11-01").status_code == 422
    ok(act(client, pid, "extend", activationSource="external_payment_verified", paymentReference="BANK-778899", reason="December payment received.",
           periodEnd="2026-12-15"))
    ok(act(client, pid, "expire", reason="Owner asked to stop at period end."))
    expired = ok(client.get(f"{base(pid)}/subscription", headers=OWNER))
    assert expired["lifecycle"] == "expired" and expired["nextAction"]["action"] == "request"
    ok(act(client, pid, "disable", reason="Account closed at owner's written request."))
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["lifecycle"] == "disabled"
    assert client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER).status_code == 409
    ok(act(client, pid, "restore", reason="Owner reopened the account by email."))
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["lifecycle"] == "draft"
    assert act(client, pid, "teleport", reason="Unknown action test").status_code == 404

    # Natural expiry: an active period that ends becomes expired without any write.
    activate_property(client, pid, period_end="2026-11-20")
    clock.now += timedelta(days=60)
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["lifecycle"] == "expired"
    assert client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Late"}).status_code == 402


def test_concurrent_or_stale_admin_changes_are_rejected(env):
    client, _, _ = env
    pid = make_property(client)
    version = admin_view(client, pid)["version"]
    ok(act(client, pid, "suspend", expectedVersion=version, reason="First admin suspends this."))
    # A second admin acting on the stale version cannot apply a contradictory change.
    stale = act(client, pid, "disable", expectedVersion=version, reason="Second admin, stale screen.")
    assert stale.status_code == 409
    assert admin_view(client, pid)["status"] == "suspended"


def test_events_are_append_only_audited_and_property_scoped(env):
    client, _, service = env
    pid = make_property(client)
    other = make_property(client, OWNER2, name="Other Place")
    ok(act(client, pid, "suspend", reason="Audit trail check suspension."))
    events = admin_view(client, pid)["events"]
    assert [e["action"] for e in events][:3] == ["suspend", "approve", "request"]
    assert all(e["propertyId"] == pid for e in events)
    assert events[0]["actorRole"] == "platform_admin" and events[-1]["actorRole"] == "owner"
    assert events[0]["fromStatus"] == "active" and events[0]["toStatus"] == "suspended"
    # Owner sees a history without staff identities or payment references.
    history = ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["history"]
    assert history[0]["action"] == "suspend" and "actorUid" not in history[0] and "paymentReference" not in history[0]
    # Property audit log mirrors the change; other properties are untouched.
    assert "subscription.suspend" in {log["action"] for log in ok(client.get(f"{base(pid)}/audit-logs", headers=OWNER))}
    assert admin_view(client, other)["status"] == "active"
    assert client.get(f"{base(pid)}/subscription", headers=OWNER2).status_code == 404
    # The service only ever creates event documents (no update path exists for them).
    assert not hasattr(service, "update_subscription_event")


def test_platform_queue_lists_pending_first_and_filters(env):
    client, _, _ = env
    active = make_property(client)
    pending = make_property(client, OWNER2, activate=False, name="Pending Place")
    ok(client.post(f"{base(pending)}/subscription/request-activation", headers=OWNER2))
    queue = ok(client.get(PLATFORM, headers=STAFF))
    assert queue[0]["propertyId"] == pending and queue[0]["ownerEmail"] == "owner2@example.com"
    assert queue[0]["allowedActions"] == ["approve", "reject", "disable"]
    assert [r["propertyId"] for r in ok(client.get(f"{PLATFORM}?status=active", headers=STAFF))] == [active]
    assert client.get(f"{PLATFORM}?status=bogus", headers=STAFF).status_code == 422
    assert ok(client.get("/api/platform/me", headers=STAFF)) == {"platformAdmin": True}
    assert ok(client.get("/api/platform/me", headers=OWNER)) == {"platformAdmin": False}


def test_unit_limit_follows_the_approved_plan(env):
    client, _, _ = env
    pid = make_property(client)
    for index in range(10):
        ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": f"U{index}"}), 201)
    assert client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "U10"}).status_code == 402
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["unitLimit"] == 10


def test_platform_admin_claim_on_anonymous_account_is_ignored(env):
    client, _, _ = env
    pid = make_property(client, activate=False)
    anonymous_admin = auth("anon-admin", provider="anonymous", email="", admin=True)
    assert client.get(f"{PLATFORM}/{pid}", headers=anonymous_admin).status_code == 403


def test_date_only_period_end_is_end_of_day_in_manila():
    from app.rentals.subscriptions import parse_period_end

    end = parse_period_end("2027-06-30")
    assert end.isoformat() == "2027-06-30T23:59:59+08:00"
    assert parse_period_end("2027-06-30T10:00:00") is None  # timestamps must carry a timezone
    assert parse_period_end("30/06/2027") is None
