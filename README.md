# Fork to Workspace（分叉到工作区）

把一个工作区里的对话复制成一棵新的分支，放到**另一个工作区**中继续。分支保留原对话的历史，并把自己的工作目录切换为目标工作区，因此后续的文件操作、终端和系统提示都会以新工作区为准。

## 使用方式

1. **侧栏菜单**：在任意对话行的 `...` 菜单里选择「分叉到工作区…」，再选目标工作区。成功后会自动打开新对话。
2. **斜杠命令**：`/fork-to-workspace <工作区 id、标题或绝对路径>`。
3. **Agent 工具**：`fork_conversation_to_workspace`，参数为 `workspace`（必填）与可选的 `session_id`、`at_seq`。Agent 可以在被要求时替用户完成分叉。

## 行为

- 默认从**最近一个已完成的回合**切分；切分点之后的未完成回合不会进入分支，开放的工具调用会用 `forked` 语义补齐关闭事件。
- 子对话的 `cwd` 是目标工作区的规范路径，`parentSession` 指向源对话，`isSeeded: true`。
- 若源对话有标题，子对话标题会按 `(1)`、`(2)`… 递增并持久化。
- 分支会出现在目标工作区的对话列表中；源对话不受影响。
- 只接受已注册、目录仍然存在的工作区；子代理（subagent）会话不能作为源。

## 安装

该包以本地 link 方式安装在 `desktop` profile 中（`@local/dsh-workspace-fork`）。更新此目录中的代码后，重新启用插件或重启 Harness 以加载新的 Host/Client 模块。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：唯一的 `forkToWorkspace` 操作、`/fork-to-workspace` 命令、`fork_conversation_to_workspace` 工具 |
| `client.js` | Client 半：对话菜单项、工作区选择对话框（`shell.overlay`）、命令调用与跳转 |
| `cordis.patch.yml` | 插入 Host 插件行 |
| `locale/*.json` | Plugin Manager / 设置页的标题与描述 |
| `icon.svg` | 插件图标 |

Host 半只使用 Node 内置模块：本地 link 安装的包位于 profile 包树之外，不能解析 `@deepseek-ai/*` 裸导入，因此 fork 种子构建在包内实现，并逐项对齐 `session.fork` 的语义。
