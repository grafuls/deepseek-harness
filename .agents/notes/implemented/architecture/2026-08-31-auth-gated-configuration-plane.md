# Agent Note: Authenticator-verified configuration plane

Status: implemented

## Problem

The `/api` privileged-method set (`settings.*`, `credentials.*`, `host.*`, `agentPreset` authoring, `llm.discoverModels`) was pinned to loopback even on a trusted-host deployment: the connection node half passed the trust fence with an empty trust list for those methods, and a declared `trustedHosts` authority could reach every other RPC but not the configuration plane. The rationale recorded in `dsh-client-connection` was that `trustedHosts` is a DNS-rebinding fence, not authentication, so nothing but loopback could be trusted with configuration until "a real authentication layer exists". The collab overlay ([2026-08-27-collab-multi-user-overlay](2026-08-27-collab-multi-user-overlay.md)) is exactly that layer — it registers a connection authenticator and refuses every `/api` request without a verified principal — yet the loopback pin persisted on top of it, so a signed-in operator on a trusted-host collab deployment still could not edit models, settings, or credentials from the GUI.

## Decision

A verified request principal may use the privileged method set from any authority the outer `/api` trust fence already admitted. In `dsh-client-connection`'s node-half `/api` fallback ([`packages/client/connection/src/index.ts`](../../../../packages/client/connection/src/index.ts)), the pin's guard becomes: non-loopback AND no current principal → 403. `connection.principal()` is how the check reads the `AsyncLocalStorage` principal that `gatedFetch` attaches after the registered authenticator runs, so:

- With no authenticator registered (single-user deployments), `principal()` is always undefined and behavior is unchanged — the whole configuration plane stays loopback-only.
- With an authenticator registered (collab overlay), any request it verified passes; anonymous callers are still refused — on collab they are already answered 401 by the auth gate before the pin, and the pin remains as a second layer for any deployment without a gate.
- The model catalog (`llm.providers`, `llm.models`) stays public exactly as before; `agentPreset.list`/`select` stay out of the privileged set.

### Client half (the browser lockout)

The pin was only the server side of the old stance. The settings browser domain mirrored it with a client-side gate: `dsh-client-ui-settings` derived every settings scope's persistence from `connection.isLoopback` and used a `'memory'` mode — never touching the wire — off the loopback origin, so even after the server admitted a principal a remote collab session still saw "settings are unavailable in this browser". The same decision removes that pre-lock: `ui-settings`' mirror and `bind()` are host-backed on every origin ([`packages/client/ui-settings/src/client/index.ts`](../../../../packages/client/ui-settings/src/client/index.ts), [`settings-scope.ts`](../../../../packages/client/ui-settings/src/client/settings-scope.ts)) — the browser asks, and the server's authenticator gate and the privileged pin answer per request. The `'memory'` persistence option remains in the mirror/scope engine only as an explicit offline choice for tests; the welcome-notice process-local fallback (`welcome-store.ts`) was removed. The loopback-only native "Open configuration file" action is untouched: it drives the host desktop and stays a loopback feature.

## Alternatives considered

### Keep the loopback pin and drive configuration out of band

Operators of collab deployments would configure models by editing `$DSH_HOME/settings.yaml` and credential files directly, or via a temporary loopback-bound single-user instance. Rejected for this deployment: the collab overlay already is the authentication layer the pin's own rationale waited for, so the GUI constraint no longer pays for security it was bought for, and file editing is error-prone for the `llm-*` namespaces the Models page writes.

### Scope the relaxation to collab admin roles

`dsh-collab-auth` principals carry a `globalRole`, so the pin could open only to admins. Not done here: the deployment-wide configuration plane matches "any verified operator of this shared instance", and the ping-pong of role checks would couple `dsh-client-connection` to collab's principal shape (the principal is deliberately opaque to the connection package). A later collab-layer authorization decision can narrow it without touching the connection gate.

## Consequences

- The configuration plane on an authenticator-bearing deployment is as reachable as the collab session that protects it: any signed-in principal can read and mutate deployment-wide settings and credentials, so the collab deployment trusts its sign-in surface for configuration integrity the same way it already trusts it for sessions (which can run bash).
- Single-user and no-authenticator behavior is byte-for-byte unchanged; the old tests still assert anonymous 403, and new tests cover the verified-principal path on both the routed handler and a real HTTP round trip.
- The `PRIVILEGED_METHODS` doc block and the `dsh-client-connection` README now state the authenticator exception; the browser-trust fence itself ([2026-07-28-api-browser-trust-boundary](2026-07-28-api-browser-trust-boundary.md)) is untouched.
