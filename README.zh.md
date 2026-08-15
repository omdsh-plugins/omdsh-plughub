# `@omdsh-plugins/omdsh-plughub`

[English](README.md) | 中文

设置里的插件中心：在自带的 Plugins 页签旁边再加一个，列出可以从上游安装的插
件，并且把已经装上的插件都配起来。

以前装一个插件是在终端里敲 `dsh plugin --profile web add <path>`，配一个插件
是手改 profile 的 `cordis.patch.yml`。现在这两件事都在页面上。

## 思路

插件中心难的不是那个"安装"按钮，而是后半截：插件装上之后，它的配置界面从哪
儿来？

有两种答案。要么每个插件都为这个面板附一张卡片——但那样的话，比这个包晚发布
的插件出现时就是一片空白，而这个包会永远按插件数量长下去。要么，面板去读插件
**本来就已经声明**的东西。

harness 让第二种答案成为可能，因为它本来就有一条 user-settings 的缝。插件用
一份 [schemastery] schema 注册一个命名空间；
`ctx.settings.describe({ redactSecrets: true })` 会把这份 schema 连同当前取值、
组装层 base、原始 user 层、脱敏后的密钥槽位和一个 revision 一起交出来。这正好
是一个配置表单需要的全部输入。

所以这个包只做两件事——渲染表单、安装包——并且不认识任何一个具体的插件。明年
才写出来的插件，只要遵守[约定](https://github.com/omdsh-plugins/omdsh-plugins/blob/HEAD/CONVENTIONS.zh.md)，装上的当天就有配置页。

```
  插件（host 半边）            plughub（host 半边）        plughub（浏览器半边）
  ────────────────            ───────────────────        ────────────────────
  ctx.settings.register(      describe(脱敏) ──────────→ rehydrateSchema
    'omdsh-shortcuts',                                    ─→ plan ─→ 控件
    Config,                   settings.mutate ←───────── 一次按路径寻址的修改
    { base: entryConfig })
```

左边一列没有提到这个包，右边一列没有提到快捷键。

### 中间那一列，以及它为什么在

那一步本该完全不存在。harness 本来就把同一条缝直接发布给浏览器，这个中心也
本该直接用——但 `settings.describe` 和 `settings.mutate` 被
`dsh-host-apiproxy` 里一张**写死的命名空间名单**挡住了。它自己的注释说得很
清楚：

> adding a section to that page is a decision made here rather than by the
> registering plugin. Moving that declaration to `settings.register()`, so a
> plugin can expose its own configuration without a change in this package, is
> deferred work.

任何 out-of-tree 的命名空间都进不了那张名单，所以建立在它之上的插件中心，只
能配置 harness 早就认识的那些插件——而这恰恰是这个插件中心存在的意义的反面。
于是它用自己的一条路由把这条缝转运了一遍。

它只承担传输，别的什么都不做：校验、分层、脱敏、并发冲突、提交，全都还在
`ctx.settings` 里。而且它画出的边界比它所替代的那条**更窄**——一个命名空间只
有在某个**已安装**的 bundle 用 `dsh.plughub.settings` 声明了它时才可达，所以
同一个进程里注册着的 `shell` 和 `agent-loop` 在这里够不到。等上游把那件
deferred work 做完，这条路由就是多余的，可以直接删掉，而不必碰任何一个插件。

## 这个页签里有什么

**目录来源**——这个插件自己的配置，放在最上面，因为这些字段回答的正是"下面这
个列表从哪儿来"。它就是一个普通的 settings 命名空间，用的是每个插件都用的那套
通用表单；只是它待在这里而不是待在已安装列表里，这样看着一个空目录的人不用去
翻找那个能修好它的开关。当所有来源都失败、或者什么都没拉到时，它会自己展开一
次。

**可安装**——合并后的目录，带安装、更新和卸载。卡片的标题、简介和文档链接都是
插件自己的，从它的 `dsh.plughub` 声明里读出来，按当前语言解析。

**已安装**——这个 profile 组装的每个 bundle 一行。展开后是按该插件的 settings
schema 生成的表单；没有注册命名空间的插件会明确说"没有可配置项"，这是一个真
实的回答，而不是一个空盒子。

profile 有变化时顶部会出现重启提示。插件层是在启动时组装的，被监听的只有用户
patch 层，所以新装的 bundle 确实没法热挂载——说"需要重启"是实话，不是拿话术
盖住一个限制。

## 更新

更新按钮在卸载左边，没东西可拉的时候是灰的。到底是哪种，由 Host 用它手上已经
有的两个数字判断——获胜来源声明的版本，和磁盘上那个包的版本——按 semver 比，
不是按字符串比（`0.10.0` 比 `0.9.0` 新，`1.0.0` 比 `1.0.0-rc.2` 新）。

| 状态 | 卡片上显示 | 按钮 |
|---|---|---|
| `available` | `0.1.0 → 0.2.0` | 高亮 |
| `current` | 单个版本号 | 灰：已是最新 |
| `linked` | 单个版本号 | 灰：从本机目录链接安装，文件本身就是来源 |
| `unknown` | 已知的那个版本号 | 灰：该来源没有提供可比较的版本号 |

更新跑的就是安装跑的那条 `dsh plugin add`——`pnpm` 会把一个已经在的依赖重新解
析一遍，对 registry 规格来说是拉最新发布版，对 git 规格来说是拉 ref 现在指向的
东西。它单独占一条路由，是因为前置条件正好相反：安装拒绝 profile 已经有的包，
更新则要求它已经有。

更新完会出现重启提示。更新不会改变 bundle **列表**——同一个包名，后面换了一份
代码——所以按列表比对会漏掉这唯一一个把运行中代码换掉的操作，运行时因此额外记
了一笔。这里故意选保守：更新拉到的是同一个版本时，代价是白重启一次；反过来的代
价是有人以为自己换了代码、其实跑的还是旧的。

`linked` 就是签出目录安装的样子，`dsh plugin add <路径>` 记的是 `link:`。所以
一个全部由本地目录拼起来的 profile，每个更新按钮都会是灰的，而这是对的——改签
出目录就已经是在改插件了。

## 目录从哪里来

三个来源，按包名合并，优先级从高到低：

| 来源 | 是什么 | 为什么存在 |
|---|---|---|
| `local` | 本地插件 checkout 目录 | 你正在改的那份，胜过别人发布的那份 |
| `registry` | 一份人工维护的 JSON 清单 | 一次请求拿到全部元数据，也是上游表达"我推荐哪些"的地方 |
| `github` | 枚举账号下的仓库 | 零维护：把插件仓库推上去它就出现了 |

优先级低的来源仍然会补上赢家缺少的 `repo`——本地 checkout 很少知道自己发布在
哪里，卡片上的链接因此更好用。

失败的来源会被**报告出来**，而不是藏起来。空列表上，"这里没有插件"和"GitHub
对这个账号限流了"长得一模一样，但只有其中一个会自己恢复。

清单格式是 `{ "plugins": [...] }`（裸数组也行）：

```json
{
  "plugins": [
    {
      "name": "@omdsh-plugins/omdsh-shortcuts",
      "repo": "omdsh-plugins/omdsh-shortcuts",
      "version": "0.1.0",
      "plughub": { "displayName": { "": "Shortcuts", "zh": "快捷键" }, "order": 10 }
    }
  ]
}
```

`spec` 可以显式写；不写时按 `github:<repo>` 推导。

## 它持有的路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/plughub/catalog` | GET | 合并后的目录，`?refresh=1` 重新拉取每个来源 |
| `/api/plughub/installed` | GET | 这个 profile 的 bundle，以及哪些可以卸载 |
| `/api/plughub/install` | POST | `{ id }`——安装一个目录条目 |
| `/api/plughub/update` | POST | `{ name }`——按目录当前提供的规格重装一个已安装插件 |
| `/api/plughub/uninstall` | POST | `{ name }`——卸载一个依赖管理的 bundle |
| `/api/plughub/events` | GET | 操作进度、重启标记与设置失效通知，事件流 |
| `/api/plughub/settings` | GET | 已安装插件持有的每个命名空间，已脱敏 |
| `/api/plughub/settings` | POST | `{ ns, ops, expectedRevision }`——一次按路径寻址的修改 |

## 可达范围

读路由用的是 `/api` 同款栅栏：Host 头指向我们（loopback，或这个部署被明确告
知要服务的 authority），加上同源的浏览器标记。它们和渲染它们的设置面板一样可
达，不多不少。

写路由是 **loopback only**，不管 `--trusted-host` 说了什么。它们每一个都会改
变这台机器：安装会执行那个包的 `prepare` 脚本，写设置会落盘到 Host 的文档。
"这个部署把 `/api` 开放到了局域网"对这两件事都不等于同意。真的想在一个已发布
的 `dsh web` 上装插件的人，仍然可以从终端装——在那里，这个决定明显是他自己做
的。

而且写请求指的都是 Host 已经解析出来的东西。安装指的是一个目录**条目**，永远
不是包 specifier——Host 在自己解析出来的目录里查 specifier，所以任何请求都够
不到配置的上游没有提供的包，而且根本不存在能携带 specifier 的请求形状。写设置
指的是某个**已安装**插件声明自己持有的命名空间。两张白名单都是结构性的，而不
是"需要有人记得写"的检查。

## 一次安装实际怎么跑

它 shell 出去执行 `dsh plugin --profile <name> add <spec>`。

`pnpm add` 只是安装的一半；另一半是把 `dsh.profile.bundles` 与磁盘上的现状对
账，而这份对账逻辑属于启动这个 runtime 的那个 launcher。在这里重新实现一遍，
意味着要维护一份必须跟上用户独立升级的程序的副本；写错的后果是，一个"刚装
好"的插件在下次启动时不在树里。

有一件事这个包必须知道：pnpm ≥10 在未加入白名单前拒绝执行依赖的安装脚本，而
一个 git 来源的 dsh 插件是**在 `prepare` 里构建自己**的——它发布出去的树里没
有 `lib/`。于是一次没加白名单的 git 安装会"成功"，写入依赖，完成 bundle 对
账，然后下次启动死在 `Cannot find module .../lib/index.js`。所以
`allowBuilds` 条目是在安装**之前**写进 profile 的 `pnpm-workspace.yaml`
的——因为那个错误比犯错晚了一次重启才出现。

操作串行执行：同一个目录里两个 `pnpm` 会抢同一把 lockfile，输的那个给出的报
错描述的是这场竞争，而不是人做错了什么。

## 表单会画哪些控件

| schema 节点 | 控件 |
|---|---|
| `string` | 文本框 |
| 带 `role('secret')` 的 `string` | 只写输入框；Host 只报告有没有存过值 |
| `number` | 数字框，遵守 `min` / `max` / `step` |
| `boolean` | 复选框 |
| 常量 `union` | 下拉选择 |
| `array(string)` | 可编辑列表 |
| `dict(string)` | 可编辑键值行 |
| `object` | 标题加缩进的子项，最多三层 |
| 其他 | 只读 JSON，并提示去改设置文件 |

最后一行是刻意的。一个对任意 schema 硬猜的通用表单，产出的控件会悄悄写进错误
的形状；一次通过了校验但含义已经变了的设置写入，比没有控件更糟。需要这个表单
画不出来的控件的插件，改为往 `omdsh.plugin.card` 注册一张卡片——见
[约定](https://github.com/omdsh-plugins/omdsh-plugins/blob/HEAD/CONVENTIONS.zh.md)第 6 条。

每次写入都是一次按路径寻址的修改，并带上这个面板读到的 revision。按路径而不是
整体替换，是因为面板收到的内容是脱敏过的：用屏幕上的内容重建一个 `replace`，
会把线上从来没送过来的密钥全部删掉。带 revision，是因为同一个面板可能被两个界
面同时打开，没有它的话第二个写入者会静默覆盖第一个；有了它，第二个会被拒绝、
重读，然后显示当前的取值。

字段的**标题**由属性名推导（`maxRepos` → `Max repos`），schema 的 description
放在它下面。schemastery 的 description 是一句话，一句话当标签并不好读；这样
schema 作者只写一份，而它落在读起来合适的位置上。

## 配置它自己

这个插件遵守它自己定的约定，所以它在自己的面板里就能配——在页签顶部的**目录
来源**里。下面这些字段都能在那里改，不用碰文件；同样也仍然可以写在
`cordis.patch.yml` 的组装配置里，那会成为面板写入所覆盖的 base 层。命名空间
`omdsh-plughub`：

| 字段 | 默认值 | 作用 |
|---|---|---|
| `upstream` | `omdsh-plugins` | 作为兜底来源被枚举的 GitHub 账号；留空则关闭 |
| `registryUrl` | 推导 | 人工维护的清单；留空则由 `upstream` 推导 |
| `localSources` | `[]` | 作为可安装条目提供的本地 checkout 目录 |
| `githubToken` | — | 解除匿名枚举每小时 60 次的限流（密钥） |
| `maxRepos` | `100` | 枚举时最多检查的仓库数 |
| `timeoutMs` | `10000` | 远程来源的单次请求超时 |
| `cacheTtlMs` | `300000` | 已解析的目录复用多久 |
| `profileDir` | 推导 | 要管理的 profile；留空则取当前运行的那个 |
| `launcher` | 推导 | `dsh` 可执行文件路径；留空则取当前运行的 runtime，再走 `PATH` |
| `pnpmPath` | 推导 | `pnpm` 可执行文件路径；留空则依次在 runtime、profile 和常见安装位置里找 |

## 安装

```sh
dsh plugin --profile web add /path/to/omdsh-plughub
dsh web
```

然后打开 **设置 → Plugins → OMDSH 插件**。

在任何东西发布之前想先用本地 checkout，把 `localSources` 设成放它们的目录。

## 命令

```sh
pnpm install
pnpm run build       # tsc → lib/types，再 tsdown → lib/{index,contract,client}.js
pnpm test
pnpm run typecheck
pnpm run harness:local ../../deepseek-harness   # 对着一份 checkout 编译
pnpm run harness:npm                            # 切回提交下来的版本号
pnpm run check:harness-pin                      # 只要还链着就失败
```

## 它从哪儿来

harness 声明 `settings.plugins.tab` 的原话就是，为了让"清单类插件和配置类插件
在互不依赖的前提下协作"（`packages/client/ui-settings/src/client/contract/slots.ts`）。
这个包是那个座位上的第三位占用者，和自带的 Configurable、All 两个页签并列。它
没有给 harness 加任何 slot，没有打任何补丁；把它移除，Plugins 区就回到它出厂
时的两个页签。

[schemastery]: https://github.com/shigma/schemastery
