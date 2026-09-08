# Agent Note: DeepSeek provider removal through a disabled section

Status: implemented

English | [中文](2026-09-08-deepseek-disable-delete.zh.md)

## Problem

The Models settings page lets a user delete every provider row except DeepSeek's. Other providers are path-addressed profiles (`settingsPath: ['providers', ...]`), so their row is removable whenever the user layer carries a profile the base does not, and removing it unsets that path. DeepSeek is the one whole-section provider: it registers `settingsPath: []`, so its configuration is the entire `llm-deepseek` namespace and its directory entry always sits in the composition `base` layer. The shared `removable` rule therefore never applies and the row shows no Delete action, so a DeepSeek installation a user wants to disable or remove cannot be managed from the page at all.

## Decision

A whole-section provider can be disabled, and the Models page treats that as removal. Two halves:

- **Plugin.** `llm-deepseek`'s `Config` gains `disabled` (default `false`). When `true`, the adapter's `deepseek-official` route is withdrawn from the adapter registry (`registration.replace([])`) so it stops serving requests and its models leave the catalog, while the configurable-provider directory entry stays declared so a configuration surface can re-enable it by clearing the flag.
- **Client.** The Models store marks a provider `disablable` when it is whole-section (`settingsPath` empty) and its section root declares a boolean `disabled` field. A disablable provider is `removable` whenever it is enabled and hidden once disabled. `targetOf` carries a `disableValue` (`{ disabled: true }`), and the delete path writes that value as a section-root `set` (instead of unsetting a profile path) plus drops the page-managed key. The page also fixes the reference it treats as page-managed: a profile naming its own `apiKeyEnv` (DeepSeek's schema default `DEEPSEEK_API_KEY`) is now recognized, so deleting the provider unsets `DEEPSEEK_API_KEY` rather than the mismatched derived `DEEPSEEK_OFFICIAL_API_KEY`.

The delete dialog copy, the editor, and the read-only gate behave exactly as for any other removable provider; disabling and re-enabling are the same user action and configuration edit.

## Alternatives considered

- **Treat DeepSeek like a path-addressed provider and unset a profile path.** Rejected: DeepSeek owns the whole namespace, so there is no profile path to unset and unsetting the root would clear the whole user `llm-deepseek:` section.
- **Remove the row by dropping the directory entry.** Rejected: the configurable-provider directory entry is how a re-enabled provider is discovered; dropping it would lose the provider entirely rather than let a configuration surface restore it.
- **Add a GUI re-enable (add-back) control in this change.** Rejected: the request was delete parity with the other providers, not a new add-back surface; re-enabling stays a `settings.yaml` edit until a follow-up.

## Consequences

- The DeepSeek row now shows the same Delete action as every other provider, and deleting it disables the provider (withdrawing its route) and removes its page-managed key.
- Disabling keeps the directory entry (the route no longer serves or lists models), so the provider can be re-enabled by clearing `disabled` in `settings.yaml`.
- A disabled provider's row, add option, and setup card are hidden from the page while its snapshot stays, so the provider directory still knows it.
- The delete credential-unset defect is corrected: DeepSeek's own `DEEPSEEK_API_KEY` is the reference cleared on removal.
