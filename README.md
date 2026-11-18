# StockLens

个人使用的 A 股股票工作台，使用 Next.js、Prisma、PostgreSQL、technicalindicators 和 OpenAI SDK。首次默认打开光迅科技 `002281.SZ`，之后保留最近股票，支持搜索、常看列表、分时、前复权日 K、公司资料、日内观察点和 AI 研究。交易由用户手动执行。

## 本地运行

当前工作区已安装依赖并初始化本地数据库 `stock_cc_local`。启动 PostgreSQL 后执行 `npm run dev`，打开 http://127.0.0.1:3000。

新机器首次启动：安装 Node.js 20.19.x 或 22.x（部署统一使用 22.x）与 PostgreSQL，创建专用数据库，复制 `.env.example` 为 `.env` 并填写 `DATABASE_URL`，然后执行：

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

Seed 可重复执行，不覆盖已有模型、点位或报告。

## 配置模型

在「偏好设置」填写 Base URL、模型名称、API Key，然后「测试并保存」。

| 服务 | Base URL | 模型名称 |
| --- | --- | --- |
| OpenAI / GPT | `https://api.openai.com/v1` | 账户可用且支持 Chat Completions 的 GPT 模型 |
| DeepSeek | `https://api.deepseek.com` | 例如 `deepseek-v4-pro` |
| 兼容代理 | 服务商的接口前缀，通常含 `/v1` | 服务商提供的 model |

调用使用官方 OpenAI SDK 6.49（兼容当前 Node 20），支持自定义接口前缀；系统追加 `/chat/completions`，也兼容输入完整聊天路径。GPT 推理模型使用 `max_completion_tokens`，DeepSeek 使用自己的思考配置，其他兼容服务使用标准聊天参数。仅支持 Chat Completions 的文本模型；供应商特有协议需要额外适配。

模型来源自动按「完整界面配置 → 完整环境变量 → 未配置」选择。没有来源切换开关，未配置时停止 AI 调用。模型 Key 加密保存在数据库中，接口不返回明文。

| 环境变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | 本机或服务器自身的 PostgreSQL 连接，必填 |
| `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` | 可选的模型后备配置 |
| `AKTOOLS_BASE_URL` | 可选 AKTools HTTP 服务，补充 AKShare 行业与交易日历 |
| `CONFIG_ENCRYPTION_KEY` | 可选；配置加密密钥优先使用此变量，不填使用项目固定默认密钥 |

配置加密密钥按「环境变量 → 项目固定默认密钥」选择，不读取或创建本地文件。保存的密文记录加密来源，原来使用项目默认密钥的配置在新增环境变量后仍可读取，再次保存时改用环境密钥。环境变量必须是 Base64 编码的32字节值，填写无效值会明确报错；环境密钥加密的配置迁移时需保留原值。

项目默认密钥随源码提供，取得源码的人也能得到它；部署时使用独立环境密钥可避免这个问题。实际 `.env` 不提交。旧版本使用本地文件加密的配置需一次性迁移，或重新填写 API Key 后保存，运行时不会再读取旧文件。

## 刷新与分析

- Node 服务只处理页面/API请求，没有启动定时采样、后台报告队列或无人值守自动任务。交易时段页面约每3秒请求一次当前股票，分钟背景按请求最多每10秒刷新；页面关闭或隐藏后停止轮询。
- 午休、盘前、盘后、周末与节假日停止定时行情请求。首次加载和手动刷新仍可取数据；打开的页面在11:31、15:01各补取一次最终分钟，13:00或下一交易日09:15继续请求。
- 竞价结果可用后和15:10以后，股票页面对当前股票发起一次相应分析。竞价研判可随时手动触发，仅使用开盘前历史竞价及同一时段的板块、指数，快照保存至现有 DailySignal JSON。关闭页面后不再启动下一项，没有后台重试和常看股票报告调度；幂等键避免重复版本。
- 股票打开或恢复时按当时及之前数据逐分钟近似回放，下午首次打开也会补算上午；监控期间按最新有效报价即时评估，新完成分钟线也独立评估收盘机会并经过 AI。两条事件流共享已处理机会与配额，分钟流不会读入更晚的报价候选。评分至少85且全部过滤通过后调用 AI，AI可否决，最多等待5秒；不可用时使用量化结果。界面显示候选、分数通过、过滤通过、量化达标次数、原因分布、预热和数据缺失。
- 每天最多3个阻力点、3个支撑点，允许没有点。V5按震荡边界、顺势回踩/反弹、逆势衰竭区分机会；突破失败或破位收复的当场证据可替代滞后的动量转向，强趋势仍须更强证据。目标取当时已知波段起点或更近的有效结构，未经承接/拒绝验证的VWAP和布林中轨不机械限制空间。仍过滤小波动、迟到、持续突破和风险收益比不足的机会。点位及依据冻结，后续价格突破只追加失效记录。85是规则评分，不表示85%胜率。
- 免费源的更新频率、网络与模型响应会影响速度。历史秒级盘口不可恢复，历史分钟回放不调用当前 AI。板块时间未核验时不参与评分。
- 历史分钟缺开盘价时仅停用影线证据，保留真实收盘、区间、量价计算，并展示数据受限；不编造开盘价。缺少必要成交或当时指数时继续拦截。V5首次请求会自动废弃旧算法运行快照并补算当天，已保存旧点保留原版本并占用当日配额；没有新增表或数据库迁移。

实现与当前规则见 [设计说明](docs/DESIGN.md)。交易日历内置已核验的2026年安排；跨年需更新日历或配置能覆盖该年的 AKShare 日历，未知日期暂停正式点位。

## 云服务器部署

使用单实例 Node.js 网页服务，准备专用线上 PostgreSQL，在服务器 `.env` 中填写线上 `DATABASE_URL`。本地数据不会自动同步到线上。

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run db:seed
npm run build
npm run start
```

开发时用 `npm run db:migrate -- --name CHANGE_NAME` 生成迁移；线上只执行已有迁移 `db:deploy`。已有库变更前备份，不在线上使用数据库重置命令。

进程管理示例在 `deploy/ecosystem.config.cjs`，Nginx示例在 `deploy/nginx.conf.example`。默认监听 `127.0.0.1:3000`，入口配置 HTTPS 和个人访问保护，代理保留 Host 且不缓存 API。

也可使用 Docker：

```sh
docker build -t stocklens .
docker run --rm --env-file .env stocklens npm run db:deploy
docker run --rm --env-file .env stocklens npm run db:seed
docker run -d --name stocklens --restart unless-stopped --env-file .env -p 127.0.0.1:3000:3000 stocklens
```

容器不需要本地密钥数据卷。容器数据库地址需从容器可达；容器内 `127.0.0.1` 指向容器自身。

## Vercel 逐步部署指南

以下采用「GitHub 个人仓库 + Vercel + Neon PostgreSQL」，以新云库部署为例，步骤核对日期为2026-11-18。代码已完成请求状态与连接池适配，已通过本地测试、真实PostgreSQL检查和生产构建；尚未创建云端资源或实际发布。云端行情接口和模型服务的连通性仍需要第8步验证。

### 已实现的部署适配

- 业务表仍为四张，`DailySignal.runtime` 保存有界请求状态和短期租约。只保留最近240根指标背景、最多100条股票报价和20条指数报价，分钟流共用背景，不重复保存全日行情。
- 每轮点位请求从数据库恢复两个因果引擎、候选和已处理机会，完成必要的数据获取、评分、AI复核与保存后返回。数据库按股票/交易日协调并发，切换股票不取消另一股票已经发出的请求。
- 点位请求租约90秒，接口上限60秒；报告租约210秒，接口上限180秒。进程中断后，由后续页面请求接管过期租约；旧请求不能覆盖新状态或保存新点。没有租约清理定时器或无人值守重试。
- AI只使用触发时冻结输入，最多5秒，可否决，不可用则按量化结果继续。保存前再次核对行情，原30秒点位截止、85分及硬过滤、每侧每天最多3点继续生效。
- 报告进度读取数据库；相同股票同类报告并发生成时，重复POST返回202和处理中状态，不重复调用模型。已保存报告仍按幂等键返回。
- PrismaPg使用每实例最多3条连接、10秒连接等待与5秒空闲超时，Vercel环境接入`attachDatabasePool`。模型加密不依赖本地文件。

### 第1步：准备账号与本地代码

1. 准备自己的GitHub、Vercel和Neon账号。个人用途可以先使用账号允许的套餐，实际额度和费用以各平台控制台为准。
2. 本地安装Node.js 22 LTS，建议22.12或更新补丁版本。当前项目也兼容本地20.19，但云端统一选择22.x。
3. 在项目目录确认依赖与构建：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

本地`.env`仍连接本地PostgreSQL。构建脚本读取`DATABASE_URL`用于Prisma配置和生成Client，但不负责云库迁移。当前工作区已执行新增迁移，其他旧工作区更新后需执行`npm run db:deploy`。

### 第2步：创建Neon数据库并获取两个地址

1. 登录Neon控制台，点击创建项目，例如命名`stocklens`。
2. 选择AWS **Singapore**（`aws-ap-southeast-1`），后续Vercel函数也放Singapore。若使用其他区域，让数据库与函数处于同一区域。
3. 选定用于正式环境的数据库分支。可以使用新项目默认分支，名称以自己的控制台为准。
4. 创建或选择专用数据库，例如`stocklens`，不要使用其他应用的数据库；保留自己的数据库角色。
5. 点击 **Connect**，选定同一分支、数据库和角色，复制两种连接URL，保留完整TLS参数：

| 地址 | 获取方法 | 用途 |
| --- | --- | --- |
| Pooled / 连接池地址 | 开启连接池；主机名通常含`-pooler` | 填入Vercel的`DATABASE_URL` |
| Direct / 直连地址 | 关闭连接池 | 本地执行Prisma迁移和初始化 |

项目保留现有`@prisma/adapter-pg`，不需要照着Neon通用教程再次安装ORM、初始化schema或更换驱动。两个URL属于同一个数据库；运行时只需要一个`DATABASE_URL`环境变量。

### 第3步：初始化正式云库

回到项目目录，用**第2步的直连URL**执行已有迁移。以下适用于macOS默认zsh，URL输入隐藏，不写入命令历史，也不修改本地`.env`：

```zsh
npm run db:generate
read -rs 'STOCKLENS_CLOUD_DATABASE_URL?粘贴正式云库直连 URL（输入隐藏）：'
DATABASE_URL="$STOCKLENS_CLOUD_DATABASE_URL" npm run db:deploy
```

确认输出显示目标云库和迁移成功，再执行：

```zsh
DATABASE_URL="$STOCKLENS_CLOUD_DATABASE_URL" npm run db:seed
unset STOCKLENS_CLOUD_DATABASE_URL
```

如果上一步失败，先解决错误，不继续seed。到Neon的Tables或SQL Editor确认有`AppSetting`、`Watchlist`、`DailySignal`、`AnalysisReport`四张业务表，`DailySignal`包含`runtime`字段；另有Prisma自动管理的`_prisma_migrations`记录表。

新库应应用两次迁移：初始表结构和`20261118065000_request_state`。Seed只初始化默认设置与常看列表，可重复执行，不覆盖已有模型、点位和报告。本地数据不会自动复制到云库。

### 第4步：将代码上传GitHub

1. 在自己的GitHub账号下创建仓库，例如`stocklens`，建议使用Private。
2. 先用`git status`检查文件，提交代码、`package-lock.json`、`prisma/schema.prisma`和全部`prisma/migrations`；不要提交真实`.env`、旧`.data`或任何供应商密钥。
3. 如果尚未提交本地代码，执行：

```sh
git add .
git commit -m "Adapt request state for Vercel deployment"
```

4. 根据GitHub空仓库页面的提示配置远程地址，并推送当前分支。远程地址、分支名称使用你自己的值；已有远程仓库时直接推送即可。不要为本项目重置其他仓库或强制覆盖远程历史。
5. 在GitHub确认可看到项目根目录的`package.json`、源码和两个迁移目录。将计划正式发布的分支设为仓库默认分支；已有仓库则确认其默认分支包含这些改动。`generated/`、`node_modules/`和`.next/`由构建生成，不需要上传。

### 第5步：在Vercel导入仓库并配置环境变量

1. 登录Vercel，点击 **Add New → Project**。
2. 连接自己的GitHub账号，授予目标仓库访问权限，找到项目并点击 **Import**。看不到Private仓库时，在GitHub的Vercel App设置中开放该仓库访问权限。
3. Framework Preset选择 **Next.js**。
4. Root Directory选择包含`package.json`的目录；如果此项目独立成仓库，就是仓库根目录。确认首次部署来自准备好的仓库默认分支。导入后可在 **Settings → Git → Production Branch** 核对正式分支；其他分支产生Preview部署，需要独立预览库。
5. 在 **Environment Variables** 中配置：

| 变量 | 是否必填 | 值 |
| --- | --- | --- |
| `DATABASE_URL` | 必填 | 第2步的正式云库连接池URL，包含供应商TLS参数 |
| `CONFIG_ENCRYPTION_KEY` | 可选 | Base64编码的32字节密钥；不填使用项目固定默认密钥 |
| `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` | 可选 | 一组完整环境模型后备配置；也可先留空，上线后在设置页填写 |
| `AKTOOLS_BASE_URL` | 可选 | Vercel可以访问的AKTools HTTPS地址；不使用就不添加 |

正式云库URL只勾选 **Production**。Preview要使用独立云库/数据库分支，不能让预览访问写入正式点位和报告。初次只部署正式环境时，可以先不配置Preview；之后使用预览前，按第2、3步初始化独立预览库，再添加仅适用于Preview的`DATABASE_URL`。

如需独立配置加密密钥，在自己的终端生成并私下保存：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

同一数据库保存模型后，应保留原环境加密密钥；不要每次部署重新生成。项目默认密钥随源码提供，有源码的人也能取得它，环境变量可用于设置独立密钥。不要将数据库或模型密钥配置成`NEXT_PUBLIC_`变量。`VERCEL`由平台自动提供，不需要手动添加。

如果导入的是旧本地数据库：`keySource: local`的旧密文需先迁移，或重新填写API Key保存；应用不会读取旧文件。当前工作区的旧本地配置已转换为项目密钥，无需携带`.data`。

### 第6步：设置构建与函数

导入时确认构建设置，首次部署后也可在Settings中修改：

| 配置 | 值 |
| --- | --- |
| Node.js Version | `22.x` |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | 使用Next.js框架默认值 |
| Fluid Compute | 开启，新项目通常默认开启 |

`npm run build`已包含`prisma generate`，无需添加Postinstall脚本，不选择静态导出，不需要配置Docker、PM2、Nginx或额外`vercel.json`。

到 **Settings → Functions → Function Regions** 选择 **Singapore / sin1**。如果导入页面没有这些设置，首次部署后修改，再重新部署使新设置生效。界面位置以当前控制台为准，Node.js版本也可能位于Build and Deployment设置。

点位与模型设置接口已配置60秒，报告接口180秒。当前启用Fluid Compute的Hobby函数上限300秒，允许这两个值。AI复核仍只有5秒；函数时限不是模型复核时限。

### 第7步：部署并保护个人站点

1. 点击 **Deploy**，等待构建和部署完成。
2. 构建失败时打开Build Logs，先查看Prisma生成或Next.js报错。常见原因是没有为该部署环境添加`DATABASE_URL`、选错Root Directory或Node版本。
3. 部署成功后打开 **Settings → Deployment Protection**。
4. 启用 **Vercel Authentication**，保护范围选择 **All Deployments**，保存。当前该组合支持所有套餐，无需Password Protection付费功能。
5. 使用自己的Vercel账号访问站点。用未登录的独立浏览器窗口打开正式域名及`/api/settings`，应先要求身份验证。

本项目面向个人使用，没有额外应用账号系统。All Deployments同时保护正式域名、预览和API；Standard Protection不保护正式域名。前端使用同站相对路径，认证后可以正常调用API。

### 第8步：逐项验收

1. **数据库**：登录后在浏览器打开`/api/health`，应看到`database: "connected"`、`stateStorage: "postgresql"`、`sampling: "page-request"`和`backgroundTasks: false`。模型尚未配置时`model: "unconfigured"`正常。
2. **模型**：到偏好设置填写供应商Base URL、model、API Key，点击测试并保存。重新打开设置页，确认已配置且没有解密错误。配置来源仍是「界面配置 → 完整环境变量 → 未配置」。
3. **行情**：打开光迅科技或另一只A股，验证搜索、常看列表、分时、日K与公司资料。确认云端可以访问腾讯/东方财富；本地访问成功不能保证云端IP访问同样成功。
4. **AI报告**：依次生成公司投研和可用的竞价研判。收盘复盘与下一交易日计划按原交易时段条件触发；竞价研判可以在竞价证据可用后随时生成。生成过程中刷新页面应继续显示处理中，重复请求不应重复调用模型。
5. **点位**：交易时段查看行情新鲜度、规则评分和历史回放状态；已完成分钟与报价按请求评估。只有85分且全部过滤通过才调用AI，允许当日没有点位，不用“必须有点”作为验收要求。
6. **恢复**：换股票、关闭后重新打开页面、重新部署后再次访问，确认已保存点位仍在；跨实例状态由数据库恢复，未观察时段只补分钟因果点位，不补造秒级盘口或历史AI结论。
7. **空闲**：浏览器Network观察页面隐藏/关闭及休市后停止新行情轮询。已发出的有限请求可以完成，但服务不会启动新采样、常看股票调度或后台报告重试。
8. **运行日志**：到Vercel的Logs/Observability筛选对应API请求。点位请求超过60秒或报告超过180秒可能返回504；同股票计算请求中断后，下次页面请求在租约过期后恢复，不需要清理后台进程。

### 第9步：以后更新代码

1. 本地修改和验证代码。若有表结构变化，本地生成迁移并提交迁移文件。
2. 使用目标云库直连URL执行第3步的`db:deploy`。已有库先备份；不在云端使用`migrate reset`或`migrate dev`。
3. 推送Vercel Production Branch对应分支，平台会部署新提交。Preview库单独迁移、单独配置环境变量。
4. 环境变量或函数区域修改后，在 **Deployments** 选择 **Redeploy** 使新配置生效。
5. 再检查health、模型和行情。构建命令不自动迁移云库，避免每个Preview构建修改正式数据库。

### 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| health返回503 | 当前部署环境的DATABASE_URL、云库连接状态、两次迁移是否成功及runtime字段是否存在 |
| 本地有配置，云端没有 | 云端新库与本地库独立，在云端重新配置模型与常看列表 |
| 模型测试成功，报告失败 | Functions日志、供应商模型输出/额度、报告证据接口、报告180秒总时限 |
| 模型解密失败 | 环境密钥是否保留原值；旧local密文是否转换，必要时重新填写API Key保存 |
| 行情接口403/超时或长期stale | 云端访问腾讯/东方财富的实际情况、函数区域及网络限制；保留数据过期过滤，不降低门槛强行出点 |
| 重复报告返回202 | 已有请求在生成，这是去重的处理中响应；页面读取数据库进度 |
| 请求中断后显示处理中 | 等待该任务租约过期，由下一页面请求恢复；点位90秒、报告210秒，无自主重试 |
| Preview连接失败 | 独立预览库是否初始化，Preview的环境变量是否设置正确 |

长期交易时段轮询会产生函数调用、数据库流量及存储用量，查看Vercel和Neon的Usage后再决定套餐；函数支持180秒不代表整日监控必然免费。内置交易日历目前覆盖2026年，跨年需更新已核验日历或配置覆盖新年度的AKTools日历。

官方参考：[Neon区域](https://neon.com/docs/introduction/regions)、[连接池与直连](https://neon.com/docs/guides/prisma)、[Vercel环境](https://vercel.com/docs/deployments/environments)、[Node版本](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)、[函数区域](https://vercel.com/docs/functions/configuring-functions/region)、[函数时限](https://vercel.com/docs/functions/limitations)、[部署保护](https://vercel.com/docs/deployment-protection)、[连接池管理](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)。

## 核心检查

```sh
npm run typecheck
npm test
npm run build
```

测试保留因果性、反转过滤、时间对齐、AI否决与时限、日内配额、配置保存、SDK兼容和页面触发后的空闲行为。移除历史回放脚本、外部探测脚本、临时截图及旧版文档。
