# Agent Note: collab 会话补丁下载

Status: implemented

[English](2026-09-08-collab-session-patch-download.md) | 中文

基于 [collab repository-backed workspaces](2026-08-29-collab-repo-backed-workspaces.zh.md)、[collab per-session work branches](2026-09-01-collab-session-work-branches.zh.md) 与 [collab branch push](2026-09-01-collab-push.zh.md)：本注记覆盖那个只读端点，它把会话分支的 diff 交给成员，作为可在本地用 `git apply` 应用的补丁。

## 问题

会话的工作落在共享克隆里各自的 `<workspace>-<session>` 分支上，推送动词把它发布到仓库。但成员若想不带拉取请求就把这份工作带到别处——基线处的一个本地检出、另一个 fork、一个离线补丁——此前没有任何方式把该分支的 diff 作为文件取回。会话行上的 git 动词（推送、同步）都是把状态推向 origin 或共享树，没有一个把会话的改动作为自包含补丁交回。

## 决策

面向成员的 RPC `collab/workspace.patch` 返回某个分支相对工作区主干的统一 diff，作为成员可保存并本地应用的补丁：

- **基于引用；纳入当前会话未提交的改动。** diff 以分支的主干 merge-base 为根，其中 `<base>` 是工作区的 `refs/remotes/origin/HEAD` 默认分支。对于并非克隆当前检出的分支，它是确定性的三点 `git diff <base>...<branch>`，只读取提交对象，因此绝不混入其他会话未提交的工作树改动。当分支**就是**克隆的当前检出时，持有它的会话可能带有属于它的未提交改动，这些改动通过把工作树与 merge-base 相 diff（`git diff <merge-base>`）被纳入；此时补丁就是该会话的完整当前状态。
- **默认线。** 未给 `branch` 参数时，端点 diff 检出的当前分支（`rev-parse --abbrev-ref HEAD`），与推送的默认值一致；显式的 `branch` 先按与推送相同的纯分支命名规则校验。
- **只读、无需确认、无需凭据。** 该 diff 完全在已落定克隆本地计算，因此既不需要成员确认，也不需要服务器 git 凭据。遇到仅命名或仍在克隆的工作区会关闭失败（`collab-not-a-repository`），并把分离检出、无法解析的主干或 git 失败（分支缺失、不是仓库）折叠为 `collab-bad-request`。
- **响应。** 端点返回 `{ branch, base, patch, filename }`，其中 `filename` 为 `<branch>.patch` 并把正斜杠替换掉，浏览器因此保存为单个扁平文件。补丁文本可被 `git apply` 应用（`--no-ext-diff --no-color --binary`）。
- **浏览器面。** 会话行菜单在推送/同步旁新增「下载补丁」动词，只对仓库支撑的已落定克隆提供（与另两个 git 动词相同的 `branch !== undefined` 门控）。它通过控制器解析补丁并把文本交给浏览器保存（控制器绝不触碰 DOM）；折叠失败则在列表上方以瞬态提示呈现。

## 考虑过的备选方案

- **当分支就是检出时纳入工作树 diff。** 采纳，但加一个窄化：只有当请求的分支正是当前持有克隆检出的分支时才纳入工作树 diff，因为这些改动属于那个会话；请求*其他*会话的分支时仍保持确定性的仅提交 diff，因此不会泄漏当前活跃者。当初的顾虑——纳入工作树会泄漏持有检出的会话——正是把纳入门控在「请求分支即检出」的原因。
- **服务器把补丁写成文件并返回 URL。** 否决：这多出一个磁盘产物和一条下载路径，而 RPC 本可在其 JSON 结果里直接携带；控制器已按同样方式路由推送/抓取结果，所以补丁作为值会保留一种传输。
- **两点 `base..branch` diff。** 否决：两点直接比较两端 tip，会把基线分支上分支尚未合并的每个提交一并纳入；三点正好显示分支引入的内容，这正是本地往基线 `git apply` 时应看到的。

## 影响

- 成员从行菜单把会话的改动下载为单个 `.patch` 文件，本地应用；共享克隆与 origin 都不被动（该读取不移动任何东西）。
- 补丁是请求时刻分支工作的快照。对于持有检出的会话，它反映完整的工作状态，包括未提交的改动；对于其他会话，它反映分支已提交的改动。这与每个会话的工作落在自身那条线的会话分支模型一致。
- diff 的方向与单位遵循 git 规则：它是基于 merge-base 的统一 diff，因此可干净地应用到底线主干的检出上；因为传了 `--binary`，重命名与二进制改动也被表示出来。
