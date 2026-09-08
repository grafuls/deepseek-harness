# Agent Note: DeepSeek provider removal through a disabled section

Status: implemented

English | [中文](2026-09-08-deepseek-disable-delete.zh.md)

## Problem

模型设置页允许用户删除除 DeepSeek 之外的所有提供方行。其他提供方是路径寻址的配置项（`settingsPath: ['providers', ...]`），因此只要用户层携带了基配置所没有的配置项，其行即可删除，删除即取消该路径。DeepSeek 是唯一的整段提供方：它注册了 `settingsPath: []`，因此它的配置就是整个 `llm-deepseek` 命名空间，而且它的目录项始终位于组合的 `base` 层。通用的 `removable` 规则因此从不生效，该行也没有删除操作，所以用户无法在页面上禁用或移除一个 DeepSeek 安装。

## Decision

整段提供方可以被禁用，模型页将其视为删除。分两部分：

- **插件。** `llm-deepseek` 的 `Config` 新增 `disabled`（默认 `false`）。当它为 `true` 时，适配器的 `deepseek-official` 路由从适配器注册表中撤回（`registration.replace([])`），从而停止服务请求、其模型也退出目录；而可配置提供方的目录项仍然保留声明，使配置面可以清除该标志来重新启用。
- **客户端。** 当提供方是整段（`settingsPath` 为空）且其段根声明了布尔 `disabled` 字段时，模型 store 将其标记为 `disablable`。可禁用的提供方在启用时可删除，一旦禁用则隐藏。`targetOf` 携带 `disableValue`（`{ disabled: true }`），删除路径将该值作为段根 `set` 写入（而不是取消一个配置项路径），并同时移除页面管理的密钥。页面还修正了它视为页面管理的凭证引用：识别到配置文件自带 `apiKeyEnv`（DeepSeek 的 schema 默认 `DEEPSEEK_API_KEY`），因此删除提供方会取消 `DEEPSEEK_API_KEY`，而不是不匹配的派生 `DEEPSEEK_OFFICIAL_API_KEY`。

删除对话框文案、编辑器以及只读门控与任何其他可删除提供方完全一致；禁用与重新启用是同一用户操作和配置编辑。

## Alternatives considered

- **把 DeepSeek 当作路径寻址提供方并取消一个配置项路径。** 被否决：DeepSeek 拥有整个命名空间，因此没有可取消的配置项路径，取消根路径会清空整个用户 `llm-deepseek:` 段。
- **通过删除目录项来移除该行。** 被否决：可配置提供方的目录项正是重新启用提供方的发现方式；删除它会完全丢失该提供方，而不是让配置面恢复它。
- **在此变更中添加 GUI 重新启用（加回）控件。** 被否决：请求是与其它提供方一致的删除能力，而非新的加回界面；在后续工作之前，重新启用仍是对 `settings.yaml` 的编辑。

## Consequences

- DeepSeek 行现在显示与所有其他提供方相同的删除操作；删除它会禁用该提供方（撤回其路由）并移除其页面管理的密钥。
- 禁用仍保留目录项（路由不再服务或列出模型），因此可以通过清除 `settings.yaml` 中的 `disabled` 来重新启用。
- 被禁用提供方的行、添加选项和设置卡从页面上隐藏，而其快照保留，使提供方目录仍能识别它。
- 删除时的凭证取消缺陷被修正：DeepSeek 自身的 `DEEPSEEK_API_KEY` 是移除时清除的引用。
