# omdsh-plughub

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 设置里的插
件中心：在自带的 Plugins 页签旁边再加一个，列出可以从上游安装的插件，并且把已
经装上的插件都配起来，或者先停用、文件还留着。插件中心和模式系统都留在栈上。

以前装一个插件是在终端里敲 `dsh plugin --profile web add <path>`，配一个插件
是手改 profile 的 `cordis.patch.yml`。现在这两件事都在页面上。

## 它提供什么

| 界面 | 从哪来 |
|---|---|
| 设置 → 插件 下的第三个页签 **插件中心** | `settings.plugins.tab` 里的一个条目——ui-settings 为"清单类"和"配置类"插件留的那个座位 |
| 合并后的目录，以及每个来源的结果 | `GET /api/plughub/catalog`，由 `local`、`registry`、`github` 三个来源解析而来 |
| 可安装上的安装或更新；已安装上的更新和卸载 | `POST /api/plughub/install`、`/update`、`/uninstall`，各自 shell 出去执行 `dsh plugin --profile <name>` |
| 已安装上的启用/停用 | `POST /api/plughub/enabled`，改写 `dsh.profile.bundles` 和一份停用名单；包仍留在 `node_modules`。插件中心和模式系统可以更新，不能停用，也不能卸载。 |
| 每个已安装插件的配置表单 | `GET`/`POST /api/plughub/settings`，转运 `ctx.settings.describe({ redactSecrets: true })` 与 `ctx.settings.mutate` |
| 操作进度与重启提示 | `GET /api/plughub/events`，一条事件流 |
| `omdsh.plugin.card` slot | `ctx.slots`——通用表单画不出来的控件，插件在这里注册自己的那张脸 |
| 它自己的 settings 命名空间 `omdsh-plughub` | `ctx.settings.register`，用的就是每个插件都用的那套通用表单 |
| 终端上的 `omdsh-plughub` | 一个 `bin`，解析的是同一份目录，跑的是路由用的同一个 `Installer` |

这个页面上有两个字符串指向这个包，中文里写法相同，英文里差一个字母，而这个差别
出自约定而不是疏忽。页签叫 **插件中心**（英文 **Plugin hub**）：它属于设置界面的
chrome，所以跟着 harness 摆在它旁边的那个页签 **Plugin list** 用 sentence case。
另一个 **Plugin Hub** 是这个包自己的 `dsh.plughub.displayName`，它只给已安装列表
里的一张卡片当标题——就是这个插件自己那张，由给别人的卡片取标题的同一段代码、从同
一个字段里取出来，而 Title Case 正是[规则 5](https://omdsh-plugins.github.io/conventions/#rule-5) 对每个
`displayName` 的要求。harness 本身没有任何改动：那个页签是一个已经发布的座位，移
除这一行就原样交还。

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
才写出来的插件，只要遵守[约定](https://omdsh-plugins.github.io/conventions/)，装上的当天就有配置页。

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

那一步曾经必须存在：harness 自己的 settings 线路被一张写死的命名空间名单挡住，
任何 out-of-tree 插件都过不去。`0.1.0-rc.7` 把那道闸拆了：Host 现在会把每一个
已注册的命名空间都送到浏览器，想在官方「可配置」页签上放一张卡片的插件，往
`settings.plugin.item` 里注册一张即可。

这条路由还在，是因为另一件事。官方页签只渲染认领了那个槽位的命名空间；这个中
心是从每个 omdsh 插件已经注册好的 schema 画出一张通用表单，包括那些从没写过
卡片的。而且它画出的边界比 Host 的更窄——一个命名空间只有在某个**已安装**的
bundle 用 `dsh.plughub.settings` 声明了它时才可达，所以同一个进程里注册着的
`shell` 和 `agent-loop` 在这里够不到。

它只承担传输，别的什么都不做：校验、分层、脱敏、并发冲突、提交，全都还在
`ctx.settings` 里。

## 这个页签里有什么

**目录来源**——这个插件自己的配置，放在最上面，因为这些字段回答的正是"下面这
个列表从哪儿来"。它就是一个普通的 settings 命名空间，用的是每个插件都用的那套
通用表单；只是它待在这里而不是待在已安装列表里，这样看着一个空目录的人不用去
翻找那个能修好它的开关。当所有来源都失败、或者什么都没拉到时，它会自己展开一
次。

**可安装**——合并后的目录，每张卡片一个按钮。没装是安装；已装且没有新版本是
灰色的更新；有新版本时同一个按钮亮起。卡片的标题、简介和文档链接都是插件自
己的，从它的 `dsh.plughub` 声明里读出来，按当前语言解析。

**已安装**——这个 profile 里的每个插件一行，无论当前是否在组装栈上。启用和停
用共用一个按钮：停用把依赖从层栈上拿下来，但不碰 `node_modules`，再用时按启
用即可，不必重新安装。模板自带的 bundle、插件中心和模式系统都不能从这里停用。展开后
是按该插件的 settings schema 生成的表单；没有注册命名空间的插件会明确说"没有
可配置项"，这是一个真实的回答，而不是一个空盒子。

profile 有变化时顶部会出现重启提示。插件层是在启动时组装的，被监听的只有用户
patch 层，所以新装的 bundle 确实没法热挂载——说"需要重启"是实话，不是拿话术
盖住一个限制。

## 更新

已安装的可安装卡片上只有更新这一个按钮，没东西可拉的时候是灰的。到底是哪种，
由 Host 用它手上已经有的两个数字判断——获胜来源声明的版本，和磁盘上那个包的
版本——按 semver 比，不是按字符串比（`0.10.0` 比 `0.9.0` 新，`1.0.0` 比
`1.0.0-rc.2` 新）。

| 状态 | 卡片上显示 | 按钮 |
|---|---|---|
| `available` | `0.1.0 → 0.2.0` | 高亮 |
| `current` | 单个版本号 | 灰：已是最新 |
| `linked` | 单个版本号 | 灰：从本机目录链接安装，文件本身就是来源 |
| `unknown` | 已知的那个版本号 | 灰：该来源没有提供可比较的版本号 |

更新跑的就是安装跑的那条 `dsh plugin add`，只是 specifier 会说清楚要去哪儿。git
规格原样不动，因为重新解析 ref 本来就是它做的全部事情；registry 规格则会补上目
录里那个版本——`pnpm add @scope/name@0.2.0`——因为对着一个清单已经满足的依赖跑
光秃秃的 `pnpm add <name>`，pnpm 会打印 `Already up to date`、什么都不改、然后以
0 退出：那次操作会报成功，而卡片上照旧挂着同一个更新。

点名版本除了正确之外还买到两件事。按钮装的是它上面印着的那个版本，而不是按下去
那一刻 `latest` 恰好指向什么；而且显式版本不受 pnpm `minimumReleaseAge` 约束——它
会把一个发布藏起来一整天，否则发布之后的第一次按下就又是那个静默空操作。代价是
profile 里记的是确切版本而不是一个范围，对一个「更新靠按按钮」的清单来说，这反而
是诚实的。

它单独占一条路由，是因为前置条件正好相反：安装拒绝 profile 已经有的包，更新则要
求它已经有。

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

开箱即用时，目录就是这个集合发布的那份策展清单，从缓存 GitHub 的 CDN 上取：

`https://cdn.jsdmirror.com/gh/omdsh-plugins/registry/registry.json`

GitHub 枚举默认关掉——`upstream` 是空的——因为那一份文件已经列出了每一个插件，而问
GitHub 这个账号有哪些仓库、再对每个仓库去拉 `package.json`，正是第一次打开页签会
变慢的原因。把 `upstream` 指到一个账号就会连同枚举一起打开；把 `registryUrl` 清空，
则会改由账号推导
`https://raw.githubusercontent.com/<account>/registry/HEAD/registry.json`。两个都
清空则只用 `localSources`。

本地来源只往下扫**一层目录**，所以一个把可安装的那一半放在 `packages/` 里的
monorepo 不会被提供。这通常是对的——这里的 monorepo 装着的多半是**另一种形态**
的 bundle，而一个 profile 只组装一种形态。确实想让它出现时，把 `localSources`
直接指向里面那一层目录。

失败的来源会被**报告出来**，而不是藏起来。空列表上，"这里没有插件"和"GitHub
对这个账号限流了"长得一模一样，但只有其中一个会自己恢复。

只有一个例外，而且是反方向的：**推导出来的清单地址返回 404** 算"没有"，不算"坏了"。
一个上游账号不发布策展清单是常态，仓库枚举本来就覆盖这种情况；要是每个默认安装底下
都挂一行红字，指着一个谁也没承诺过的文件，只会训练人忽略报告失败的那个位置。而人手
填进 `registryUrl` 的地址是相反的情形：他本来就认为那里该有一份清单，所以它的 404
和其他失败一样会被报告出来。

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

这个账号发布的清单在
[`omdsh-plugins/registry`](https://github.com/omdsh-plugins/registry)，由各插件
自己的 `package.json` 生成，而不是手工维护。

## 它持有的路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/plughub/catalog` | GET | 合并后的目录，`?refresh=1` 重新拉取每个来源 |
| `/api/plughub/installed` | GET | 这个 profile 的插件，哪些可以卸载，哪些在组装栈上 |
| `/api/plughub/install` | POST | `{ id }`——安装一个目录条目 |
| `/api/plughub/update` | POST | `{ name }`——按目录当前提供的规格重装一个已安装插件 |
| `/api/plughub/uninstall` | POST | `{ name }`——卸载一个依赖管理的 bundle |
| `/api/plughub/enabled` | POST | `{ name, enabled }`——组装或停用一个依赖管理的插件 |
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

写**包名**对 registry 依赖是对的，对 git 依赖则不够。pnpm 给 git 来源的包用的
key 是它实际解析到的那个 tarball——`@scope/name@https://codeload.github.com/
owner/repo/tar.gz/<sha>`——而且拒绝任何别的写法，所以那条提前写好的条目形式正
确、实际无效。那个 commit 在安装前是不可知的，除非把 pnpm 自己的解析重写一
遍，而且插件每推一次它就变。

所以先写名字；如果 pnpm 仍然拒绝，就去问它。它的拒绝信息里印着它想要的那个精
确 key，把这个 key 读回来写进去，再跑一次安装。

**只要还在学到新东西，就继续跑**——因为 pnpm 报的是它**实际撞到**的那个拒绝，
而不是接下来会撞到的那些。一个有原生依赖的插件，先卡在那个依赖上，等它被放行
之后才轮到插件自己的 `prepare`：`omdsh-remdev` 要三轮，正是这个原因。循环的条
件是"有没有进展"而不是次数：一个已经是 `true` 的条目没有新东西可写，所以某一轮
什么都没教给它时循环就结束；上限四次只是兜底，而不是让一次正常安装停下来的东西。

有一件事必须"回答"而不是"读取"：pnpm 会**自己**把被拦的包写进那个文件，值是
`set this to true or false`。那是一个问句，而按下 Install 的人已经回答过了，所
以那个值会被改写，而不是被当成"条目已存在"。

操作串行执行：同一个目录里两个 `pnpm` 会抢同一把 lockfile，输的那个给出的报
错描述的是这场竞争，而不是人做错了什么。

## 同样的安装，在终端里

这个包带一个 `bin`。它就是上面那条安装路径，只是入口从路由换成了 argv：

```sh
omdsh-plughub list                     # 目录里有什么，已经装了什么
omdsh-plughub add omdsh-status         # 装一个
omdsh-plughub update omdsh-status      # 挪到目录里那个版本
omdsh-plughub remove omdsh-status      # 卸一个
```

它存在的理由就是上一节。集合里从 npm 装的有两个——这个包，以及 `omdsh-basemode`。
其余每一个插件都从 GitHub 装，而 git 安装就没有一条能用的 `dsh plugin add`——pnpm
要的那个 allowlist key 里带着它解析出来的 commit，只能从报错里抄，事先写不出来。
这个包一直知道该怎么应付，只是在此之前它只应答一个按钮。

这里没有第二套实现。命令解析的是同一份目录，从里面取出同一个 specifier，交给同一
个 `Installer`——所以从终端装上的插件和从页签装上的插件，是同一条依赖、同一行
bundle、同一次重启。

### 是名字，还是 specifier

一个参数属于哪一种，决定了要不要去查目录；也正是这一点，让你能点名某一个账号，而
不必把整份目录搬过去：

| 你敲的 | 它装的 |
|---|---|
| `omdsh-status` | 目录里名字以这一段结尾的那个条目；匹配到两个会如实报出来，而不是替你猜 |
| `@omdsh-plugins/omdsh-status` | 就是那个条目，点名点全 |
| `github:someone/omdsh-status` | 就那个仓库，照字面装，完全不查目录 |
| `@omdsh-plugins/omdsh-status@0.1.2` | 同上，并锁到某个版本 |
| `/checkouts/omdsh-status` | 同上，从一份 checkout 装——这里允许，而路由里拒绝，这正是 `isInstallableSpec` 的 `allowPath` 一直以来的用途：一条在键盘上敲出来的路径，和一条从别人清单里送进来的路径，不是一回事 |

`--upstream <账号>` 把整份目录挪到另一个账号上，只对这一次运行有效。这是同一个问
题的另一半——参数说的是**取什么**，upstream 说的是**目录去哪儿找**——也正因为如
此，一个光秃秃的名字不必自己去背一个账号。

**它不读这个插件存下来的设置。** 一个命名空间是由 harness 的 settings 服务在一棵
运行中的树里解析的，而这个程序不是那样一棵树，所以 `--upstream`、
`--github-token`、`--registry-url` 和几个超时都是命令行参数，默认值与 schema 里
声明的那一套相同。`--help` 会把它们列出来。

## 表单会画哪些控件

| schema 节点 | 控件 |
|---|---|
| `string` | 文本框 |
| 带 `role('secret')` 的 `string` | 只写输入框，存过值以后显示为掩码；Host 只报告有没有存过 |
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
[约定](https://omdsh-plugins.github.io/conventions/#rule-6)第 6 条。

每次写入都是一次按路径寻址的修改，并带上这个面板读到的 revision。按路径而不是
整体替换，是因为面板收到的内容是脱敏过的：用屏幕上的内容重建一个 `replace`，
会把线上从来没送过来的密钥全部删掉。带 revision，是因为同一个面板可能被两个界
面同时打开，没有它的话第二个写入者会静默覆盖第一个；有了它，第二个会被拒绝、
重读，然后显示当前的取值。

字段的**标题**由属性名推导（`maxRepos` → `Max repos`），schema 的 description
放在它下面。schemastery 的 description 是一句话，一句话当标签并不好读；这样
schema 作者只写一份，而它落在读起来合适的位置上。

而属性名是个英文标识符——中文界面上的表单因此总是只翻译了一半。所以 schema 可以
自己写标题，写在 `meta.extra` 里（schemastery 自己留给表单渲染器的那个槽位），
形状和本地化的 description 一样是一张语言映射表：

```ts
Schema.string().extra('extra', { label: { '': 'Model route', zh: '模型路由' } })
Schema.string().role('secret', { label: { '': 'API key', zh: '密钥' } })
```

第二种写法不是花样：`role(text, extra)` 写的是同一个槽位，而且只传一个参数时会把
`undefined` 写进去，所以带 role 的字段必须**通过 role** 声明标题。写了标题之后，
属性名会作为一枚 code 小标签回到标题旁边——那正是要去设置文档里改的人需要的。
这个集合里每一个拥有设置命名空间的插件都这样声明标题，包括下面这张表里的字段：
一个渲染表单的插件，自己的面板却只翻译了一半，那是在跟自己较劲。

## 配置它自己

这个插件遵守它自己定的约定，所以它在自己的面板里就能配——在页签顶部的**目录
来源**里。除了一个字段以外，下面这些都能在那里改，不用碰文件；同样也仍然可以
写在 `cordis.patch.yml` 的组装配置里，那会成为面板写入所覆盖的 base 层。命名
空间 `omdsh-plughub`：

| 字段 | 默认值 | 作用 |
|---|---|---|
| `upstream` | （空） | 作为兜底来源被枚举的 GitHub 账号；留空则关闭 |
| `registryUrl` | `https://cdn.jsdmirror.com/gh/omdsh-plugins/registry/registry.json` | 人工维护的清单；留空则由 `upstream` 推导 |
| `localSources` | `[]` | 作为可安装条目提供的本地 checkout 目录 |
| `githubToken` | — | 解除匿名枚举每小时 60 次的限流（密钥） |
| `maxRepos` | `100` | 枚举时最多检查的仓库数 |
| `timeoutMs` | `10000` | 远程来源的单次请求超时 |
| `cacheTtlMs` | `300000` | 已解析的目录复用多久 |
| `profileDir` | 推导 | 要管理的 profile；留空则取当前运行的那个。只在组装处生效——见下 |
| `launcher` | 推导 | `dsh` 可执行文件路径；留空则取当前运行的 runtime，再走 `PATH` |
| `pnpmPath` | 推导 | `pnpm` 可执行文件路径；留空则依次在 runtime、profile 和常见安装位置里找 |

`profileDir` 就是面板不提供的那一个字段。这个运行时管哪个 profile，在插件挂载
时就定下来了——installer、路由、以及判断是否需要重启所比对的 bundle 列表，全
都绑在它上面，而 settings 层是在那之后才解析的。所以它对表单 `.hidden()`，只
在组装这个插件的地方设置，这正是 `omdsh-shortcuts` 在 `items` 和 `bindings`
之间画的那条线。

如果这套组装里根本没有 settings 服务——无头的 surface、一个测试台——插件中心就
只按组装配置跑：**目录来源**会直接说明这一点而不是画出表单，每个已安装插件都
显示为没有声明可配置项，而目录、安装和卸载都和平时一样。注册走的是
`ctx.inject(['settings'], …)`，所以"可配置"在这里是附加的，而不是前提。

## 安装

```sh
dsh plugin --profile web add @omdsh-plugins/omdsh-plughub
dsh web
```

然后打开 **设置 → 插件 → 插件中心**，集合里其余插件已经列在那里了——目录清单
是默认值，所以需要在终端里装的只有这一个插件。也可以按插件中心自己在卡片上用的
写法，直接从账号装一个发布版：

```sh
dsh plugin --profile web add github:omdsh-plugins/omdsh-plughub
```

这一条**第一次跑一定失败**，而且失败的是 pnpm，不是这个包：git 依赖靠 `prepare`
自建，而 pnpm ≥10 在包进入 `allowBuilds` 之前不会跑任何这类脚本。pnpm 和 `dsh`
都会把该往 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 里加的那一条打印出来，
而它是完整的 specifier——`'@omdsh-plugins/omdsh-plughub@https://codeload.github.com/…/<sha>': true`
——不是包名；一旦有过一次被拒绝的尝试，光写包名就不够了。上面那条 npm 写法完全
不需要这些，**通过**插件中心装的东西也不需要：这个包在跑安装之前会自己把那一条
写好，这就是按一个按钮和粘一段 YAML 的区别。

或者从一份 checkout 装，改插件中心本身时要的就是这种：

```sh
pnpm install && pnpm run build
dsh plugin --profile web add /path/to/omdsh-plughub
```

想让本地 checkout 和上游并列出现，把 `localSources` 设成放它们的目录；同名包下，
checkout 胜过任何已发布的版本。

### `omdsh-plughub` 这条命令从哪儿来

`bin` 是随这个包一起发的，所以把它装进一个 profile，命令会落在那个 profile 的
`node_modules/.bin` 里——你 `PATH` 上的任何东西都找不到它，下面第一种写法就是为
这个准备的：

```sh
npx @omdsh-plugins/omdsh-plughub add omdsh-status          # 什么都不用先装
npm install -g @omdsh-plugins/omdsh-plughub                # 然后：omdsh-plughub add …
"$DSH_HOME"/profiles/web/node_modules/.bin/omdsh-plughub add omdsh-status
```

三种写法跑的是同一个程序、对着同一个 profile：它读的是 `$DSH_HOME` 和
`--profile`，而不是自己是被怎么启动的，所以二进制来自哪里，从不改变它写进哪个
profile。

移除也是同一种写法：

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-plughub
```

这会同时带走页签、路由和 settings 网关。Plugins 区回到**插件配置**和**插件列表**
两个页签，而**通过**插件中心装的每个插件都还在——那些是 profile 自己的 bundle
行，由 launcher 写入，并不由这个包持有。

它旁边不需要再组装别的东西。宿主半边只 inject `webServer`，settings 注册又挂在
`ctx.inject(['settings'], …)` 上，所以一个完全没有 settings provider 的 profile
照样有页签、有目录、能装能卸——只是每个已安装插件都显示为没有声明可配置项。

## 命令

```sh
pnpm install
pnpm run build       # tsc → lib/types，再 tsdown → lib/{index,contract,client,cli}.js
pnpm test
pnpm run typecheck
pnpm run harness:local ../../deepseek-harness   # 对着一份 checkout 编译
pnpm run harness:npm                            # 切回提交下来的版本号
pnpm run check:harness-pin                      # 只要还链着就失败
```

## 它从哪儿来

harness 声明 `settings.plugins.tab` 的原话就是，为了让"清单类插件和配置类插件
在互不依赖的前提下协作"（`packages/client/ui-settings/src/client/contract/slots.ts`）。
这个包是那个座位上的第三位占用者，和 harness 自带的两个页签并列：**插件配置**
（`configurable` 条目，出厂的 Bash、Agent loop、Web search 三张卡片就归它）和
**插件列表**（`all` 条目，把组装进来的每个 bundle 列一遍）。它没有给 harness
加任何 slot，没有打任何补丁；把它移除，Plugins 区就回到这两个页签。

## 已知限制

- **每一次安装、更新、卸载、启用和停用都需要重启。** 插件层是在启动时组装的，
  被监听的只有用户 patch 层，所以新装的或刚停用的 bundle 没法热挂载。提示条说
  的就是这件事，它背后没有一个"以后版本会悄悄修好"的东西。
- **本地来源只往下扫一层目录。** 配置的根目录里放的是插件 checkout，凡是自己的
  `package.json` 里没有 `dsh.bundle.patch` 的都会被跳过——所以把可安装的那一半
  放在 `packages/` 里的 monorepo 不会被提供。想让它出现，就把 `localSources`
  指向里面那一层。
- **匿名的 GitHub 枚举有限流。** 不带令牌时每小时 60 次，而且无论如何 `maxRepos`
  最多只看 100 个仓库。失败会显示在来源那一行而不是藏起来；`githubToken` 可以
  解除限流。
- **`profileDir` 不能在面板里改。** 这个运行时管哪个 profile，在插件挂载时、
  settings 层解析之前就定下来了，所以这个字段对表单 `.hidden()`，只属于组装配置。
- **写路由只限回环。** 一个开放到局域网的 `dsh web` 可以浏览目录、读面板，但安装、
  更新、卸载、启用、停用和写设置都会被拒绝——把 `/api` 发布出去，并不等于同意在这台机器上执行
  某个包的 `prepare` 脚本。
- **一个命名空间只有在被某个已安装 bundle 声明时才可达。** 网关是按
  `dsh.plughub.settings` 判断归属的，所以由"不是 profile 的 bundle"注册的命名
  空间——比如 harness 自己的 `shell` 和 `agent-loop`——在这里天然看不到。
- **通用表单画不出来的 schema 会被拒绝。** 字符串、数字、布尔、常量 union、字符串
  列表、字符串字典和嵌套对象之外的东西，一律渲染成只读 JSON 并提示去改设置文件。
  需要更多的插件，改为往 `omdsh.plugin.card` 注册一张卡片。

[schemastery]: https://github.com/shigma/schemastery
