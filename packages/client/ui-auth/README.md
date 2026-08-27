# @deepseek-ai/dsh-client-ui-auth

English | [中文](README.zh.md)

The collab sign-in gate for the Web GUI. This browser plugin probes the collab session endpoint (`/api/collab/auth/session`) and, while the browser holds no valid session cookie, covers the whole app with a full-screen "Sign in with Google" page. It registers a single entry into the layout's `shell.overlay` slot, so it composes out cleanly: without the collab overlay row it is not even mounted, and when mounted against a non-collab instance it renders nothing (the probe folds any absence to a no-op verdict). The server's own `/api` gate remains the enforcement point in every case — this UI only ever fails open.

The login button navigates the browser to `/api/collab/auth/login`, the gate starts the browser OIDC round-trip, and the gateway redirects back with a `dsh_collab_session` cookie, after which the gate disappears on the reload. A server-side refusal (the gateway bounces to `/?collab=<reason>`) is shown on the card.

## What it mounts

- Node half (`src/index.ts`): inert — the package is entirely browser-side.
- Browser half (`src/client/`): a `shell.overlay` entry whose inject face exposes the `collabGate` store hook plus a `signIn` callback that navigates to the OIDC start URL. The probe runs on mount and whenever the window regains focus (a sign-in on another tab clears the gate here).

## Wire contract

The session/sign-in path literals live in `src/client/contract.ts` and are pinned by tests on both sides of the wire:

| Literal | Value |
| --- | --- |
| `COLLAB_SESSION_PATH` | `/api/collab/auth/session` |
| `COLLAB_SIGN_IN_PATH` | `/api/collab/auth/login` |

The probe folds every failure mode (network error, non-OK status, non-JSON body, missing `authenticated` field) to `absent`, which renders nothing — a collab configured for a non-loopback host that denies the fence never wedges the app behind a fictional gate.

## Model Experience

None, as this is a pure presentation gate; the auth fence it reflects is enforced server-side by the collab API gateway, which owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **No connection-level recovery after sign-in** — the OIDC round-trip is a full-page navigation, so the app behind the gate reloads with the fresh cookie rather than hot-reconnecting the `/api` transport. Live recovery of a 401'd connection is deferred.
- **Fail-open UI, not enforcement** — this plugin only surfaces the session verdict; it never claims to authorize or deny requests. A collab instance must keep the collab API gateway (its own 401 fence) mounted.
- **Copy follows the active app locale** — the gate registers its `collab.auth` dictionary (Chinese + English) on the standard locale seat, so the card language tracks the GUI's Language setting rather than a hardcoded string.
