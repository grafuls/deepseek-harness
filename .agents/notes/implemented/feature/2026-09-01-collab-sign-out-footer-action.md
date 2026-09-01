# Agent Note: collab sign-in gate gains a sign-out footer action

Status: implemented

English | [中文](2026-09-01-collab-sign-out-footer-action.zh.md)

## Problem

The collab instance authorized browsers through Google OAuth, and a signed-out session was not reachable from the GUI: the `dsh_collab_session` cookie stayed valid until it expired, so on a shared machine the only way to end an authenticated browser session was to leave the instance or wait out the cookie. There was no sign-out affordance, even though the collab API gateway already served a `POST /api/collab/auth/logout` route that clears the cookie.

## Decision

The ui-auth browser plugin now registers a second surface beside the full-screen sign-in gate: a sign-out footer action in the sidebar's `sidebar.footer.action` seat (the additive list beside Settings), rendered only while a collab session probe reports authenticated. The expanded column shows a labeled row (icon + 退出登录 / Sign out); the collapsed rail shows the same action as an icon-only circle with a tooltip. Clicking it POSTs to `/api/collab/auth/logout` and, only once the gateway accepts (2xx), flips the shared collab gate store to `unauthenticated` — which re-covers the app with the sign-in overlay. A refused logout leaves the authenticated gate in place.

The logout path sits beside the existing session/login literals as `COLLAB_LOGOUT_PATH` in `src/client/contract.ts`, pinned by the gateway's route test and the browser contract tests. The overlay and the footer action share the same `collabGate` store through the same injected hook, so the two surfaces always agree, and the initial probe plus the focus re-probe continue to serve both.

## Alternatives considered

- **A sign-out entry inside the settings panel.** Rejected: settings is for preferences; an identity action belongs at the sidebar foot beside Settings, where the shell already declares the `sidebar.footer.action` seat, and where it stays visible without opening a panel.
- **A full-page redirect to a logout page.** Rejected: the gateway's POST logout returns 204 and the client owns the gate verdict, so flipping the shared store re-covers the app in place with no navigation and no reload.
- **A new package (for example `ui-sign-out`).** Rejected: the sign-out lives on the auth gate's own store and probe; it is one more surface of the existing ui-auth plugin, not a new domain, and a new package would duplicate the gate plumbing and the module-table row.

## Consequences

- An authenticated user can end their browser session from the sidebar foot on a shared machine; the app returns to the sign-in gate immediately after the server confirms the logout.
- The footer action only exists while a collab surface is mounted and authenticated, so single-user installs (and unsigned-in browsers) remain visually unchanged.
- The logout is committed only on server acceptance, so the UI never claims a session the fence still holds — the gate's fail-open posture is preserved.
- The gateway's logout route previously had no GUI consumer; the footer action is now its only one.

## Testing

Browser contract tests pin `signOut()` (accepted 204, non-OK status, network failure); the plugin-wiring test walks the shared gate store from `authenticated` to `unauthenticated` on an accepted logout and holds it on a refused one; the component spec pins the footer action's visibility contract and its wide/rail forms. `pnpm run test:gui` passes for the touched packages.

## Related

- [Multi-user collab overlay](2026-08-27-collab-multi-user-overlay.md) — the Google-OAuth gate and RBAC decision whose browser half this extends with the sign-out affordance.
