package mc8yp.transaction

import rego.v1

# ─────────────────────────────────────────────────────────────────────────────
# Single decision object — the only entrypoint, consumed by evaluate.ts.
#   action  : "allow" | "elicit" | "deny"
#   reasons : human-readable deny messages (empty unless action == "deny")
#
# Priority: deny > elicit > allow
#   deny   — a hard block (tenant / bulk-delete limit / restricted field) or an
#            explicit "deny" path_policy matches any transaction
#   elicit — no deny, but some transaction matches an "elicit" rule, or matches
#            no rule at all (the safe default)
#   allow  — no deny, no elicit, and every transaction matches an "allow" rule
# ─────────────────────────────────────────────────────────────────────────────

decision := {"action": action, "reasons": reasons}

default action := "elicit"

action := "deny" if count(reasons) > 0

action := "allow" if {
	count(reasons) == 0
	not _any_elicit
	_all_allow
}

# ── Deny reasons (each clause adds a message; any message ⇒ deny) ─────────────

reasons contains msg if {
	not _tenant_allowed
	msg := sprintf(
		"Tenant '%v' is not in the allowed list",
		[input.principal.tenant],
	)
}

reasons contains msg if {
	deletes := count([tx | some tx in input.transactions; tx.method == "DELETE"])
	deletes > data.limits.max_deletes_per_transaction
	msg := sprintf(
		"Bulk DELETE limit exceeded: %v requested, max %v allowed",
		[deletes, data.limits.max_deletes_per_transaction],
	)
}

reasons contains msg if {
	some tx in input.transactions
	tx.method in {"POST", "PUT", "PATCH"}
	some field in data.restricted_body_fields
	_ = tx.body[field]
	msg := sprintf(
		"%v %v attempts to set restricted field '%v'",
		[tx.method, tx.path, field],
	)
}

reasons contains msg if {
	some tx in input.transactions
	some rule in data.path_policies
	rule.action == "deny"
	_matches(rule, tx)
	msg := sprintf(
		"%v %v is denied by policy",
		[tx.method, tx.pathTemplate],
	)
}

# ── Elicit / allow checks ─────────────────────────────────────────────────────

_any_elicit if {
	some tx in input.transactions
	some rule in data.path_policies
	rule.action == "elicit"
	_matches(rule, tx)
}

_all_allow if {
	every tx in input.transactions {
		some rule in data.path_policies
		rule.action == "allow"
		_matches(rule, tx)
	}
}

# ── Helpers ───────────────────────────────────────────────────────────────────

_tenant_allowed if input.principal.tenant in data.allowed_tenants

# A rule matches a transaction when method (or "*") and the path glob both match.
_matches(rule, tx) if {
	rule.method in {"*", tx.method}
	glob.match(rule.path_glob, ["/"], tx.pathTemplate)
}
