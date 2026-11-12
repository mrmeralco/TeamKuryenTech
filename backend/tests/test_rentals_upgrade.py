"""Rentals end-to-end upgrade: draft setup, lifecycle, units, readings, bills, review/publish,
tenant review requests, notifications, and isolation."""

from datetime import timedelta

from test_rentals_api import (  # noqa: F401  (env is a pytest fixture)
    OWNER, OWNER2, STAFF, STRANGER, TENANT, TENANT2, activate_property, base, env, invite_tenant, make_property, ok, publish,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def setup_individual(client, pid, label="1A", meter_label="M1"):
    unit = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": label}), 201)
    meter = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": meter_label, "kind": "utility_individual"}), 201)
    ok(client.post(f"{base(pid)}/meter-assignments", headers=OWNER,
                   json={"meterId": meter["id"], "unitId": unit["id"], "effectiveFrom": "2026-01-01"}), 201)
    return unit, meter


def reading(client, pid, meter_id, day, kwh, headers=OWNER):
    return client.post(f"{base(pid)}/readings", headers=headers,
                       json={"meterId": meter_id, "readingDate": day, "valueKwh": kwh, "confirmed": True})


def bill(client, pid, meter_id, start="2026-09-01", end="2026-09-30", kwh="100", amount=150_000, **extra):
    return client.post(f"{base(pid)}/utility-bills", headers=OWNER, json={
        "meterId": meter_id, "periodStart": start, "periodEnd": end, "totalKwh": kwh, "amountCentavos": amount, **extra,
    })


def activate(client, pid):
    activate_property(client, pid)


# ----------------------------------------------------------- milestone 1
def test_draft_property_allows_setup_but_blocks_paid_workflows(env):
    client, _, _ = env
    pid = make_property(client, activate=False)
    prop = ok(client.get(base(pid), headers=OWNER))
    assert prop["entitlement"]["lifecycle"] == "draft" and prop["entitlement"]["active"] is False
    unit, meter = setup_individual(client, pid)
    prop = ok(client.get(base(pid), headers=OWNER))
    assert prop["setup"]["unitCount"] == 1 and prop["setup"]["meterCount"] == 1
    assert prop["setup"]["unitsWithoutBillingArrangement"] == []
    # Paid operational workflows stay locked on drafts (402).
    assert reading(client, pid, meter["id"], "2026-09-01", "10").status_code == 402
    assert bill(client, pid, meter["id"]).status_code == 402
    assert client.post(f"{base(pid)}/invitations", headers=OWNER, json={"role": "tenant", "unitId": unit["id"]}).status_code == 402
    assert client.get(f"{base(pid)}/analytics", headers=OWNER).status_code == 402
    # The unit cap applies to drafts too.
    for index in range(9):
        ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": f"U{index}"}), 201)
    assert client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Eleventh"}).status_code == 402


def test_lifecycle_moves_draft_pending_active_expired_and_lists_in_workspaces(env):
    client, clock, _ = env
    pid = make_property(client, activate=False)
    ok(client.post(f"{base(pid)}/subscription/request-activation", headers=OWNER))
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["lifecycle"] == "pending_activation"
    activate(client, pid)
    workspaces = ok(client.get("/api/account/workspaces", headers=OWNER))["rentalMemberships"]
    assert workspaces[0]["lifecycle"] == "active"
    clock.now += timedelta(days=40)
    assert ok(client.get(f"{base(pid)}/subscription", headers=OWNER))["lifecycle"] == "expired"
    # Past-due properties are read-only, including setup.
    assert client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "Late"}).status_code == 402


def test_archived_property_is_read_only_and_requires_move_outs(env):
    client, _, _ = env
    pid = make_property(client)
    unit, _ = setup_individual(client, pid)
    invite_tenant(client, pid, unit["id"])
    assert client.post(f"{base(pid)}/archive", headers=OWNER, json={"confirm": True}).status_code == 409
    occupancy = ok(client.get(f"{base(pid)}/members", headers=OWNER))["occupancies"][0]
    ok(client.post(f"{base(pid)}/occupancies/{occupancy['id']}/end", headers=OWNER, json={"endDate": "2026-10-01"}))
    assert client.post(f"{base(pid)}/archive", headers=OWNER, json={}).status_code == 422
    archived = ok(client.post(f"{base(pid)}/archive", headers=OWNER, json={"confirm": True}))
    assert archived["entitlement"]["lifecycle"] == "archived"
    assert client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "New"}).status_code == 409
    assert client.get(f"{base(pid)}/units", headers=OWNER).status_code == 200


def test_unit_edit_occupancy_status_duplicates_and_safe_archive(env):
    client, _, _ = env
    pid = make_property(client)
    unit, meter = setup_individual(client, pid)
    other = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1B"}), 201)
    assert client.patch(f"{base(pid)}/units/{other['id']}", headers=OWNER, json={"label": "1a"}).status_code == 409
    assert client.patch(f"{base(pid)}/units/{other['id']}", headers=OWNER, json={"occupancyStatus": "rented"}).status_code == 422
    updated = ok(client.patch(f"{base(pid)}/units/{other['id']}", headers=OWNER, json={"label": "1C", "occupancyStatus": "maintenance"}))
    assert updated["label"] == "1C" and updated["occupancyStatus"] == "maintenance"
    assert client.patch(f"{base(pid)}/units/{other['id']}", headers=TENANT, json={"label": "X"}).status_code == 404
    # Archiving keeps readings and ends meter assignments; occupied units cannot be archived.
    assert reading(client, pid, meter["id"], "2026-09-01", "10").status_code == 201
    invite_tenant(client, pid, unit["id"])
    assert client.post(f"{base(pid)}/units/{unit['id']}/archive", headers=OWNER, json={"confirm": True}).status_code == 409
    occupancy = ok(client.get(f"{base(pid)}/members", headers=OWNER))["occupancies"][0]
    ok(client.post(f"{base(pid)}/occupancies/{occupancy['id']}/end", headers=OWNER, json={"endDate": "2026-10-01"}))
    archived = ok(client.post(f"{base(pid)}/units/{unit['id']}/archive", headers=OWNER, json={"confirm": True}))
    assert archived["status"] == "archived" and len(archived["endedAssignmentIds"]) == 1
    assert len(ok(client.get(f"{base(pid)}/readings", headers=OWNER))) == 1
    assert len(ok(client.get(f"{base(pid)}/members", headers=OWNER))["occupancies"]) == 1
    # Archived units free a slot and their label may be reused.
    ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)


# ----------------------------------------------------------- milestone 3
def test_readings_report_intervals_and_flag_anomalies_without_altering_values(env):
    client, _, _ = env
    pid = make_property(client)
    _, meter = setup_individual(client, pid)
    for day, kwh in (("2026-06-01", "100"), ("2026-07-01", "130"), ("2026-08-01", "160"), ("2026-09-01", "190"), ("2026-10-01", "400")):
        assert reading(client, pid, meter["id"], day, kwh).status_code == 201
    rows = {r["readingDate"]: r for r in ok(client.get(f"{base(pid)}/readings", headers=OWNER))}
    assert rows["2026-06-01"]["intervalWh"] is None
    assert rows["2026-07-01"]["intervalWh"] == 30_000 and rows["2026-07-01"]["intervalDays"] == 30
    assert rows["2026-10-01"]["intervalWh"] == 210_000 and rows["2026-10-01"]["anomalies"]
    assert rows["2026-08-01"]["anomalies"] == []
    # Lower values are rejected with guidance, never converted to zero.
    low = reading(client, pid, meter["id"], "2026-10-10", "50")
    assert low.status_code == 422 and "retire this meter" in low.json()["detail"]
    # createdAt (server time) is kept separately from the observation date.
    assert rows["2026-06-01"]["createdAt"].startswith("2026-10-15")


def test_meter_replacement_requires_retirement_and_blocks_new_readings_on_old_meter(env):
    client, _, _ = env
    pid = make_property(client)
    unit, meter = setup_individual(client, pid)
    assert reading(client, pid, meter["id"], "2026-09-01", "500").status_code == 201
    assert client.post(f"{base(pid)}/meters", headers=OWNER,
                       json={"label": "M2", "kind": "utility_individual", "replacesMeterId": meter["id"]}).status_code == 422
    assert client.post(f"{base(pid)}/meters/{meter['id']}/retire", headers=OWNER,
                       json={"retiredOn": "2026-08-01", "reason": "Meter replaced"}).status_code == 409
    ok(client.post(f"{base(pid)}/meters/{meter['id']}/retire", headers=OWNER, json={"retiredOn": "2026-09-01", "reason": "Meter replaced"}))
    assert reading(client, pid, meter["id"], "2026-09-10", "510").status_code == 409
    new = ok(client.post(f"{base(pid)}/meters", headers=OWNER,
                         json={"label": "M2", "kind": "utility_individual", "replacesMeterId": meter["id"]}), 201)
    ok(client.post(f"{base(pid)}/meter-assignments", headers=OWNER,
                   json={"meterId": new["id"], "unitId": unit["id"], "effectiveFrom": "2026-09-02"}), 201)
    assert reading(client, pid, new["id"], "2026-09-10", "3").status_code == 201


def test_reading_evidence_is_manager_only(env):
    client, _, _ = env
    pid = make_property(client)
    unit, meter = setup_individual(client, pid)
    invite_tenant(client, pid, unit["id"])
    saved = ok(reading(client, pid, meter["id"], "2026-09-01", "5"), 201)
    path = f"{base(pid)}/readings/{saved['id']}/evidence"
    assert client.put(path, headers={**OWNER, "Content-Type": "text/plain"}, content=b"hello").status_code == 422
    ok(client.put(path, headers={**OWNER, "Content-Type": "image/png"}, content=PNG))
    assert client.get(path, headers=OWNER).content == PNG
    assert client.get(path, headers=TENANT).status_code == 403
    assert client.get(path, headers=STRANGER).status_code == 404


def test_bills_detect_duplicate_numbers_validate_components_and_stay_owner_entered(env):
    client, _, _ = env
    pid = make_property(client)
    _, meter = setup_individual(client, pid)
    bad = bill(client, pid, meter["id"], chargeComponents=[{"label": "Generation", "amountCentavos": 100_000}])
    assert bad.status_code == 422 and "add up" in bad.json()["detail"]
    saved = ok(bill(client, pid, meter["id"], billNumber="MER-001", chargeComponents=[
        {"label": "Generation", "amountCentavos": 100_000}, {"label": "Taxes", "amountCentavos": 50_000},
    ]), 201)
    assert saved["verification"] == "owner_entered" and len(saved["chargeComponents"]) == 2
    duplicate = bill(client, pid, meter["id"], start="2026-08-01", end="2026-08-30", billNumber="mer-001")
    assert duplicate.status_code == 409


# ----------------------------------------------------------- milestone 4
def test_statement_must_be_reviewed_before_publishing_and_tenant_never_sees_drafts(env):
    client, _, _ = env
    pid = make_property(client)
    unit, meter = setup_individual(client, pid)
    invite_tenant(client, pid, unit["id"])
    saved = ok(bill(client, pid, meter["id"]), 201)
    ok(client.post(f"{base(pid)}/utility-bills/{saved['id']}/statements", headers=OWNER), 201)
    statement = ok(client.get(f"{base(pid)}/statements", headers=OWNER))[0]
    assert statement["meterConfiguration"] == "utility_individual" and statement["reviewedAt"] is None
    assert client.post(f"{base(pid)}/statements/{statement['id']}/finalize", headers=OWNER).status_code == 409
    assert client.post(f"{base(pid)}/statements/{statement['id']}/review", headers=TENANT).status_code == 403
    ok(client.post(f"{base(pid)}/statements/{statement['id']}/review", headers=OWNER))
    assert ok(client.get(f"{base(pid)}/me/statements", headers=TENANT)) == []  # reviewed is still unpublished
    ok(client.post(f"{base(pid)}/statements/{statement['id']}/finalize", headers=OWNER))
    assert len(ok(client.get(f"{base(pid)}/me/statements", headers=TENANT))) == 1
    kinds = [n["kind"] for n in ok(client.get("/api/rentals/notifications", headers=TENANT))]
    assert "statement.published" in kinds


def test_tenant_review_request_flow_and_isolation(env):
    client, _, _ = env
    pid = make_property(client)
    unit1, meter1 = setup_individual(client, pid)
    unit2, _ = setup_individual(client, pid, label="2A", meter_label="M2")
    invite_tenant(client, pid, unit1["id"], TENANT)
    invite_tenant(client, pid, unit2["id"], TENANT2)
    saved = ok(bill(client, pid, meter1["id"]), 201)
    ok(client.post(f"{base(pid)}/utility-bills/{saved['id']}/statements", headers=OWNER), 201)
    statement = ok(client.get(f"{base(pid)}/statements", headers=OWNER))[0]
    message = {"message": "Please double-check the kWh on this statement."}
    path = f"{base(pid)}/me/statements/{statement['id']}/review-request"
    assert client.post(path, headers=TENANT, json=message).status_code == 404  # not published yet
    publish(client, pid, statement["id"])
    assert client.post(path, headers=TENANT2, json=message).status_code == 404  # someone else's statement
    request = ok(client.post(path, headers=TENANT, json=message), 201)
    assert client.post(path, headers=TENANT, json=message).status_code == 409
    assert client.get(f"{base(pid)}/review-requests", headers=TENANT).status_code == 403
    assert ok(client.get(f"{base(pid)}/me/review-requests", headers=TENANT2)) == []
    owner_kinds = [n["kind"] for n in ok(client.get("/api/rentals/notifications", headers=OWNER))]
    assert "statement.reviewRequested" in owner_kinds
    ok(client.post(f"{base(pid)}/review-requests/{request['id']}/resolve", headers=OWNER, json={"resolution": "Checked against the bill; figures are correct."}))
    mine = ok(client.get(f"{base(pid)}/me/review-requests", headers=TENANT))
    assert mine[0]["status"] == "resolved"


def test_notifications_are_private_to_each_recipient(env):
    client, _, _ = env
    pid = make_property(client)
    unit, _ = setup_individual(client, pid)
    invite_tenant(client, pid, unit["id"])
    owner_items = ok(client.get("/api/rentals/notifications", headers=OWNER))
    assert {"property.created", "invitation.accepted"} <= {n["kind"] for n in owner_items}
    assert all(n["recipientUid"] == "owner" for n in owner_items)
    assert ok(client.get("/api/rentals/notifications", headers=OWNER2)) == []
    assert client.post(f"/api/rentals/notifications/{owner_items[0]['id']}/read", headers=TENANT).status_code == 404
    assert ok(client.post(f"/api/rentals/notifications/{owner_items[0]['id']}/read", headers=OWNER))["readAt"]


def test_tenant_sees_own_shared_meter_share_but_not_other_units(env):
    client, _, _ = env
    pid = make_property(client)
    u1 = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1A"}), 201)
    u2 = ok(client.post(f"{base(pid)}/units", headers=OWNER, json={"label": "1B"}), 201)
    shared = ok(client.post(f"{base(pid)}/meters", headers=OWNER, json={"label": "Main", "kind": "utility_shared"}), 201)
    ok(client.post(f"{base(pid)}/allocation-agreements", headers=OWNER, json={
        "meterId": shared["id"], "description": "Lease clause 7: split by floor area, 60/40.",
        "shares": [{"unitId": u1["id"], "weight": 60}, {"unitId": u2["id"], "weight": 40}],
        "effectiveFrom": "2026-01-01", "acknowledgeLegalReview": True,
    }), 201)
    invite_tenant(client, pid, u1["id"])
    mine = ok(client.get(f"{base(pid)}/me/unit", headers=TENANT))
    assert mine["sharedArrangements"] == [{
        "meterLabel": "Main", "description": "Lease clause 7: split by floor area, 60/40.", "unitWeight": 60, "totalWeight": 100,
        "effectiveFrom": "2026-01-01", "effectiveTo": None,
    }]
    assert "1B" not in str(mine)


def test_analytics_uses_saved_readings_filters_by_date_and_compares_same_meter(env):
    client, _, _ = env
    pid = make_property(client)
    _, m1 = setup_individual(client, pid)
    _, m2 = setup_individual(client, pid, label="2A", meter_label="M2")
    assert reading(client, pid, m1["id"], "2026-09-02", "10").status_code == 201
    ok(bill(client, pid, m1["id"], "2026-08-01", "2026-08-31", "100", 100_000), 201)
    ok(bill(client, pid, m2["id"], "2026-08-01", "2026-08-31", "300", 300_000), 201)
    ok(bill(client, pid, m1["id"], "2026-09-01", "2026-09-30", "120", 120_000), 201)
    data = ok(client.get(f"{base(pid)}/analytics", headers=OWNER))
    alerts = {a["meterLabel"]: a["issue"] for a in data["missingReadingsAlerts"]}
    assert "M1" not in alerts and "No verified readings" in alerts["M2"]
    september = [p for p in data["billingPeriods"] if p["periodStart"] == "2026-09-01"][0]
    assert september["kwhChangePercent"] == 20.0  # vs M1's August bill, not M2's
    assert {t["meterLabel"] for t in data["meterTrends"]} == {"M1", "M2"}
    filtered = ok(client.get(f"{base(pid)}/analytics?from=2026-09-01&to=2026-09-30", headers=OWNER))
    assert [b["periodStart"] for b in filtered["bills"]] == ["2026-09-01"]
    assert client.get(f"{base(pid)}/analytics?from=2026-09-30&to=2026-09-01", headers=OWNER).status_code == 422
    other = make_property(client, OWNER2, name="Other")
    assert client.get(f"{base(other)}/analytics", headers=OWNER).status_code == 404
