# MiNavigateRing（导航环）

把手机上**高德地图**的步行 / 骑行导航，同步到**小米手环 9 NFC** 的一个独立导航页：转向箭头、距下一转向的距离、路名；换转向或临近路口时手环震动。手机锁屏后继续工作。

> **English summary** — An Android app plus a Xiaomi Vela quick app (RPK) that mirror Amap (AutoNavi) walking / cycling turn-by-turn instructions from a phone to a Xiaomi Smart Band 9 NFC. The phone reads Amap's ongoing-navigation notification (text only), parses direction / distance / road, and sends compact JSON to the band through Xiaomi's official wearable SDK (via the Mi Fitness app). The band page shows the arrow, distance and road name, and vibrates on a new turn or when a turn is close. Personal project, tested on one phone/band combination only (see [Verification status](#验证状态)); not affiliated with or endorsed by Xiaomi or Amap. MIT licensed.

**非官方项目**：与小米、高德无关，也未获得其认可。仅供个人学习和自用，使用风险自负（给手环安装第三方应用有风险，请先读 [小米官方 Vela 文档](https://iot.mi.com/vela/quickapp/)）。

## ⚡ 快速开始（小米手环 10 PRO）

安装分两步：**先做完「📋 提前准备」（不用手环，现在就能搞），再在手环到手后做「🔧 上手安装」**。命令在仓库根目录执行（除非注明）。

### 📋 提前准备（不用手环，现在就能做）

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| 1 | 准备官方 SDK（AAR） | 下载 `xms-wearable-lib_1.4_release.aar` 放 `app/libs/`，跑 `python scripts/check-aar-hash.py` 校验（见 [docs/sdk-provenance.md](docs/sdk-provenance.md)） | ✅ 本仓库已就绪 |
| 2 | 签名证书 | 调试证书已固化在 `app/signing/`（`debug.jks` + 配套 PEM），手机 APK 与手环 RPK 复用同一份 | ✅ 本仓库已就绪 |
| 3 | 构建手环端 RPK | `node scripts/build-rpk-hap21.js` → `band-app/dist/*.rpk`（已用同源证书签名） | ✅ 本仓库已构建好 |
| 4 | 电脑装 **AstroBox** 并登录小米账号 | 装 RPK 用，只需账号、不用手环 | ⬜ 需你操作 |
| 5 | 手机开 USB 调试、装好「小米运动健康」 | 装 APK 与互联用 | ⬜ 需你操作 |
| 6 | 构建手机端 APK（需 Android SDK） | `./gradlew :app:assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`（不想装 SDK？见下方 🤖 自动出包，云端代编） | ⬜ 需你机器 |

> 第 1–3 项在本编译环境已提前完成；你在本机重做时按下方「构建」章节跑一遍即可。第 4–6 项不依赖手环，拿到手环前就能准备好。

### 🔧 上手安装（手环到手后，约 5 分钟）

1. **装到手机**：`adb install -r app/build/outputs/apk/debug/app-debug.apk`；给「导航环」开**通知读取**权限；把「导航环」和「小米运动健康」都设为**自启动 + 省电无限制 + 豁免电池优化**（否则息屏后后台被冻结，手环收不到更新）。
2. **装到手环（AstroBox）**：
   1. 手环：**设置 → 系统操作 → 连接新手机**。
   2. 电脑打开 **AstroBox**，登录你的小米账号，按提示把手环配对到 AstroBox。
   3. 在 AstroBox 选「安装快应用 / Install Quick App」，选择 `band-app/dist/com.minavigatering.probe.debug.*.rpk`。
   > 注：Band 9 的官方「Debug → 第三方应用 → 安装 RPK」路径在 10 PRO 上不适用，请走 AstroBox。
3. **手机首次设置**：打开「导航环」→ 允许通知读取 → 选「步行」或「骑行」→ 开启导航桥。
4. **开导航**：高德开始步行 / 骑行导航，手环「导航环」页自动打开，显示转向箭头 + 距离 + 路名，转向或临近路口时震动。

> ⚠️ **装完请先真机验证**：按 [docs/band10pro-verification.md](docs/band10pro-verification.md) 的清单逐项记录（能否装/开、导航帧能否收到、骑行/震动/长锁屏等）。有三处本环境无法替你确认的点见下节。

## 小米手环 10 PRO 适配说明（本 fork）

原项目面向 **小米手环 9 NFC（192×490，Vela 4.x）**。本 fork 让它能装到 **小米手环 10 PRO（336×480，Vela 5.0）**，相对原版只改了以下内容：

- `manifest.json` 的 `minPlatformVersion` 由 `1070` 改为 `1000`（依据：社区已确认在 10 PRO 跑通的「江浙沪离线导航」用的就是 1000；原值 1070 在 Vela 5.0 上可能被拒）。
- `designWidth` 保持 `192`：Vela 按 `屏幕宽 / designWidth = 336 / 192 ≈ 1.75` 自动放大，布局比例不变，零改动风险。
- 14 个导航图标已放大到 **245×245**（336 屏上 `.nav-icon(140px)` 的真实物理像素，避免运行时放大发虚）。
- 手环端构建改用 **hap-toolkit 2.1.0**（社区已确认在 10 PRO 可跑）；本 fork 已加 `scripts/build-rpk-hap21.js`，本地验证可产出 `minPlatformVersion:1000` 的 RPK 并用 `app/signing` 同源证书签名。原 `aiot-toolkit 2.0.5` 路径保留，但在 Vela 5.0 上是否可运行**未验证**。

> ⚠️ **仍需你真机确认的三点**（本编译环境无法连接手环，无法替你确认）：
> 1. **AAR 1.4 与 Vela 5.0 互通**：手机用官方 `xms-wearable-lib_1.4_release.aar`（原作者针对 Band 9）。若装上都收不到导航帧，需向小米要更新的 interconnect SDK。
> 2. **hap 版 RPK 在你手环上能否装/开**（已本地验证可构建）。
> 3. 骑行模式、震动手感、长时间锁屏——原作者即标注未验证，本次同样未验证。

## 它是怎么工作的

```
高德地图 ──导航通知──▶ AmapNotificationService（通知监听，只看高德的通知）
                          │  AmapParser：只按文字解析方向 / 距离 / 路名；认不出就标“无法识别”，绝不猜方向
                          ▼
                  导航状态 + 提醒去重（纯 Kotlin，可在 JVM 上单测）
                          ▼
           ProbeForegroundService（前台服务，每 5 秒心跳；导航期间才持有唤醒锁）
                          │  MessageApi.sendMessage（UTF-8 JSON）
                          ▼
   小米官方 xms-wearable SDK ──▶ 小米运动健康 ──蓝牙──▶ 手环上的快应用“导航环”（回执 ack）
```

- 手机端 **不用** 逆向蓝牙协议：通信走小米官方的手机端 SDK，依赖小米运动健康在后台工作。
- 手机端应用代码里没有任何网络请求；它只读取高德（`com.autonavi.minimap`）的通知，不读其他应用的通知。
- 导航开始时，手机会自动调用 SDK 的 `launchWearApp` 把手环上的导航页拉起来（默认开，可在诊断页关闭）。

手环页只有三种显示：

| 手环显示 | 什么时候 |
|---|---|
| 方向箭头 + 距离 + 路名 | 有可用的转向信息（14 种动作之一） |
| 暂无导航 | 尚未开始、已结束、或高德这条通知读不出方向。原因不写在手环上，写在手机主页 |
| 连接中 | 超过 15 秒没有收到手机的帧 |

![手环上的几种显示（示意图）](docs/images/band-screens.png)

<sub>示意图：按手环页面实际使用的图标、字号和颜色绘制，不是实机照片；字体和行距与真机略有出入。</sub>

手机主页的“导航环”会显示同样的内容，并在“信息暂不可用”时按原因给出三种说明，见 [docs/state-copy.md](docs/state-copy.md)。

## 验证状态

下列结论来自作者本人的一台设备组合：**Redmi K90 至尊版（HyperOS 3.0 / Android 16）+ 小米手环 9 NFC（固件 3.1.32）+ 小米运动健康 3.59.1**，2026 年 10 月。其他手机、固件、系统版本都没有验证过。

| 项 | 状态 |
|---|---|
| 读取高德真实导航通知，解析出“N 米后左转”“直行 N 米”等样本 | 已在真机确认（步行） |
| 经官方 SDK 发送、手环导航页回执 | 已确认（往返约 0.1–0.5 秒） |
| 导航开始时自动拉起手环导航页 | 已确认；会顶掉手环上正在看的页面，手环熄屏时不会自己亮屏 |
| 手环显示“暂无导航”、文字居中 | 已由作者目视确认 |
| 只在导航期间持有唤醒锁、空闲时不持有 | 已在真机测量 |
| 覆盖安装 / 手机重启 / 进程被划掉后导航桥自动恢复，通知监听自动重绑 | 已观察到（前提：本应用和小米运动健康都已设自启动、省电策略“无限制”，否则息屏后会被系统冻结） |
| 骑行模式的真实导航 | 未验证（只有协议和单测） |
| 转向与临近提醒的震动手感 | 已实现，真机体感未专门验证 |
| 连续 30 分钟以上的锁屏 / 口袋场景、手环运动记录中被顶掉的行为、长时间空闲后后台拉起 | 未验证 |
| [PROJECT_SPEC.md](PROJECT_SPEC.md) 第 9 节的 A01–A12 验收清单 | 尚未完整跑完 |

高德的通知内容不固定：有时只有“高德地图持续为您导航”这类通用文字，没有方向和距离，这时手环显示“暂无导航”，应用不会猜方向。

## 🤖 自动出包（CI，免装 Android SDK）

不想在自己电脑装 Android SDK / Gradle 那一套？这个仓库自带 GitHub Actions 工作流，在云端帮你把 **手机 APK + 手环 RPK 一起编好**，发布到仓库的 Releases 页面。你只要下载两个文件装上去就行。

**怎么用**
1. 把改动推送到 `main` 分支（或到仓库 Actions 页点 `Build & Release (Band 10 PRO)` → `Run workflow`）。
2. 等几分钟，构建完成后打开仓库右侧 **Releases**，找到最新的 `CI Build #…`。
3. 下载里面的 `app-debug.apk` 和 `com.minavigatering.probe.debug.*.rpk`。

**重要约束**
- ⚠️ 每次 Release 的 APK 和 RPK 是用**同一份证书**签的，必须**两个一起下载、一起安装**。不要把这个 RPK 和别处（比如你自己本地编的）APK 混用 —— 证书不一致手环会收不到导航。
- 工作流每次运行都会生成新的临时证书，所以**跨 Release 的旧包也不能和新包混用**。
- 编译细节见 [.github/workflows/build-release.yml](.github/workflows/build-release.yml)：云端下载官方 AAR → 校验哈希 → Gradle 编 APK → hap-toolkit 2.1.0 编 RPK → 上传 Release。

> 真机实测清单仍适用：装好后请按 [docs/band10pro-verification.md](docs/band10pro-verification.md) 逐项记录。

## 构建

### 手机端（Android）

需要：JDK 21（AGP 9.x 运行要求）、Android SDK（compileSdk 37，注意平台包名是 `android-37.2`）、Python 3 和 `keytool`（首次构建时用来生成**本地**调试签名）。嫌装 SDK 麻烦？见上方 🤖 自动出包（CI），云端直接帮你编好。

```bash
# 二选一：设置环境变量，或在仓库根目录建 local.properties（含 sdk.dir=...，已被 .gitignore 忽略）
export ANDROID_HOME=/path/to/Android/Sdk

./gradlew :app:testDebugUnitTest assembleDebug     # Windows 用 gradlew.bat
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

- 技术栈：Kotlin、Jetpack Compose、Android Gradle Plugin 9.4.1、Gradle 9.8.1（用仓库自带的 wrapper）。minSdk 26，targetSdk 36。
- 调试签名证书（`app/signing/debug.jks` + 配套 PEM + 口令文件）**已固化进仓库**，手机 APK 与手环 RPK 无论本地还是 CI 构建都复用同一把证书，满足小米互联「同包名同证书」的硬性要求；仅供调试联调，非生产密钥。`scripts/gen-debug-signing.py` 只在证书缺失时兜底生成，已存在的不会覆盖。
- 小米官方手机端 SDK（`xms-wearable-lib_1.4_release.aar`）**不随仓库分发**，没有它手机端无法编译：请按 [docs/sdk-provenance.md](docs/sdk-provenance.md) 从小米官方示例包里取出这个文件，放进 `app/libs/`，再用 `python scripts/check-aar-hash.py` 校验哈希（来源、大小、哈希都写在那份文档里）。

### 手环端（Vela 快应用 RPK）

需要：Node.js 20 或更新（作者用 24）。**小米手环 10 PRO 的照做版见上方「⚡ 快速开始」第 2 步。**

```bash
# 小米手环 10 PRO（Vela 5.0 / 336×480）推荐路径：hap-toolkit 2.1.0
node scripts/build-rpk-hap21.js
# 产物：band-app/dist/com.minavigatering.probe.debug.<versionName>.rpk

# 原默认路径（aiot-toolkit 2.0.5，未经 Vela 5.0 真机验证，仅 Band 9 适用）
cd band-app && npm install        # 安装 aiot-toolkit 2.0.5
cd .. && node scripts/build-rpk.js
```

- 手环应用和手机应用**必须同包名、同签名证书**（官方 interconnect 的要求），所以 RPK 用的是手机端 `app/signing/` 里的同一份证书，**请先完成一次手机端构建**再构建 RPK。构建细节见 [docs/rpk-build.md](docs/rpk-build.md)。
- 手环页是 UX + JavaScript（`band-app/src`），designWidth 192，Vela 会按 `屏幕宽/192` 自动放大（Band 10 PRO 上约 1.75×），布局比例不变。

### 测试

```bash
./gradlew :app:testDebugUnitTest                   # 手机端单测，50 项
cd band-app && npm install                         # 先装依赖
cd .. && node --test band-app/test/startup.test.js band-app/test/session.test.js band-app/test/codec.test.js
```

`scripts/test-product-runtime.js`（手环页的“宿主门禁”）依赖作者本机上一个只读的快应用运行层（路径写死在脚本里），**外部环境无法直接运行**。`tests/` 下的 Python 脚本是实机探针工具的测试，也和作者的设备环境相关。

## 其他设备（小米手环 9 NFC 等 Vela 手环）

目前仓库不提供预编译的 APK / RPK，请先按上面的“构建”自己生成。

- **手机端**：`adb install -r app/build/outputs/apk/debug/app-debug.apk`。
- **小米手环 9 NFC**：参考小米官方资料里的“Debug → 第三方应用 → 安装 RPK”路径（需要对应版本的小米运动健康，见 [PROJECT_SPEC.md](PROJECT_SPEC.md) 第 10 节），或使用第三方蓝牙安装工具。
- **小米手环 10 PRO**：不走上面的官方路径，请见顶部「⚡ 快速开始」第 4 步（AstroBox）。
- 装之前请核对哈希，不要装来路不明的包。

## 首次设置

> Band 10 PRO 的极简版见上方「⚡ 快速开始」第 5 步；下面是每一步为什么这样做。

在手机上打开“导航环”，主页下半部分有“设置清单”，按下面三步来（都做完后这一块会自己消失）：

1. **允许“通知读取”**：点“允许”跳到系统设置，给“导航环”打开。应用只读高德的通知。
2. **后台不被冻结**（小米 / HyperOS）：把**本应用**和**小米运动健康**都设为“允许自启动”、省电策略“无限制”，并豁免电池优化，清单里有对应的按钮。不做这一步，息屏后系统会冻结后台，手环收不到更新。
3. **选模式并开桥**：选“步行”或“骑行”，点“开启导航桥”。

## 日常使用

1. 手机上的“导航桥”保持开启（重启手机、覆盖安装后会自己恢复，不用每次打开应用）。
2. 在高德里搜地点，选步行或骑行，开始导航。
3. 手环上的“导航环”页面会自动打开；手环熄屏时不会自己亮屏，抬腕就能看到。页面显示转向图标、动作名、距离，高德给了路名才显示路名。
4. 出现新的转向时手环提醒一次；步行距转弯 30 米、骑行 100 米时再提醒一次（同一个转向最多两次）。手环震动的体感还没有在真机上专门验证。
5. 导航结束后手环显示“暂无导航”，手机主页写明原因（比如高德已退出，或这条提示读不出转向方向）。

不想让手环页自己打开：在手机主页底部点“连接诊断与测试”，关掉“开始导航时自动拉起手环导航页”开关（默认开）。那一页的“最近一次自动拉起”一行会写明上一次的结果。

### 手机主页长什么样

| 等待导航 | 导航中（示例数据） | 信息暂不可用（写明原因） |
|:---:|:---:|:---:|
| <img src="docs/images/phone-home-waiting.png" width="220" alt="手机主页：等待导航"> | <img src="docs/images/phone-home-navigating.png" width="220" alt="手机主页：导航中"> | <img src="docs/images/phone-home-unavailable.png" width="220" alt="手机主页：信息暂不可用"> |

- 中间的大卡片就是手环上显示内容的镜像。
- “手环：已发现，尚未确认收到”只表示手机找到了手环，不代表手环已经回执。
- 页面底部“连接诊断与测试”进入诊断页，里面有“开始导航时自动拉起手环导航页”的开关（默认开），下面一行写着上一次自动拉起的结果：

<img src="docs/images/phone-diagnostics-autolaunch.png" width="440" alt="诊断页：自动拉起开关与上一次结果">

<sub>截图来自 Redmi K90 至尊版。“导航中”这张用的是应用内置的合成示例数据（路名“合成道路”），不是真实路线；“信息暂不可用”这张是一次真实导航结束后的状态。</sub>

### 📜 运行日志（内置，便于排查）

诊断页里有「运行日志（持久化·可分享）」按钮，打开后是**应用自己记录的日志**，不用连电脑抓 logcat：

- 自动记录权限（授予/拒绝）、节点发现、SDK 发送失败、自动拉起结果等关键事件，进程退出也不丢；
- 顶部可按「全部 / 错误 / 警告 / 信息 / 调试」筛选，支持自动滚到底；
- 点「分享」把日志文件通过系统面板发出（微信/邮件都行），发给开发者即可定位问题。

> 手环还会每 5 秒把自身的显示状态（标题、是否有距离/路名、渲染是否报错）回传，手机日志里以「手环状态: …」一行呈现。手环若一直黑屏，先看日志里是「权限被拒 / 自动拉起失败」还是「手环状态: 标题=异常初始化」——前者是权限没给，后者是手环页没初始化成功。

## 常见问题

| 现象 | 怎么办 |
|---|---|
| 开始导航后手环页没有自己打开 | 看诊断页的“最近一次自动拉起”：`skipped:PAGE_ALIVE` 是手环页本来就开着；`skipped:ALREADY_LAUNCHED` 是这次导航已经拉起过一次；`skipped:SETTING_OFF` 是开关关了；`skipped:BRIDGE_OFF` 是导航桥没开；`skipped:NO_NODE` 是手机没找到手环；`not-installed` 是手环上没装应用。每次导航最多自动拉起一次，之后可以自己在手环上打开。 |
| 手环显示“暂无导航”，但高德明明在导航 | 高德有时只发“正在为您步行导航”这类通用通知，没有方向和距离；应用不会猜方向，等高德发下一条带转向的通知。手机主页会写明原因。 |
| 手环显示“连接中” | 超过 15 秒没有收到手机的帧。检查手机上的“导航桥”是否开着、小米运动健康是否还连着手环、有没有被省电策略限制。 |
| 息屏一会儿后不更新 | 多半是系统冻结了后台：把本应用和小米运动健康设为自启动、省电“无限制”。 |
| 手机主页写“通知读取未连接” | 到系统设置里把“导航环”的通知读取关闭再开启一次。 |

## 消息协议（UTF-8 JSON）

`state` 字段固定顺序：`v, kind, id, sentAtMs, link, navStatus, action, exitNumber, distanceM, roadName, actionId, mode, heartbeat`；`ack` 字段：`v, kind, id, refId, sentAtMs`。

| 字段 | 取值 |
|---|---|
| `kind` | `state` \| `ack` |
| `navStatus` | `idle` \| `active` \| `unrecognized` \| `ended` |
| `action` | `left, right, straight, slight-left, slight-right, sharp-left, sharp-right, keep-left, keep-right, uturn-left, uturn-right, roundabout-enter, roundabout-exit, arrive`；其他值一律当“无法识别”，**绝不改成 `straight`** |
| `mode` | `walk` \| `cycle` |
| `exitNumber` | 缺省为 `null`，不推断 |

规则（都有单测）：

- 心跳（`heartbeat=true`）每 5 秒一次，只刷新存活时间，不改变方向 / 距离，也不触发提醒。
- 手环超过 15 秒没收到有效帧，显示“连接中”，并且不依据旧指令产生新的提醒。
- 新的 `actionId` 提醒一次；只是距离变化不提醒。步行距转弯 30 米、骑行 100 米时再提醒一次，同一 `actionId` 最多一次；新指令首次出现时已在阈值内，则两次提醒合并为一次。

完整的需求、状态表和验收标准在 [PROJECT_SPEC.md](PROJECT_SPEC.md)。

## 目录

```
app/                  Android 手机端
  src/main/java/com/minavigatering/probe/
    protocol/         消息结构与 JSON 编解码（纯 Kotlin）
    engine/           导航状态与提醒去重（纯 Kotlin）
    navigation/       高德通知监听与解析、主页状态映射、设置、开机恢复
    transport/        官方 SDK 通信、前台服务、唤醒锁策略、手环页自动拉起
  libs/               放小米官方手机端 SDK（AAR，需自行放入，不入库）
band-app/             手环端 Vela 快应用（UX / JavaScript）
scripts/              构建 RPK、签名生成、包身份核验、实机探针脚本
tests/                探针脚本的 Python 测试
design/               界面设计稿、图标规范（HTML / SVG）
docs/                 各项功能的说明与实机记录（见下）
PROJECT_SPEC.md       首版需求、状态表、验收标准
```

文档索引（`docs/`）：

| 文档 | 内容 |
|---|---|
| [state-copy.md](docs/state-copy.md) | 手环三种显示与手机端各原因的原句 |
| [auto-launch-band.md](docs/auto-launch-band.md) | 导航开始时自动拉起手环页：规则、日志、限制 |
| [wear-launch-experiment.md](docs/wear-launch-experiment.md) | 拉起接口的实机实验方法 |
| [lockscreen-minimal.md](docs/lockscreen-minimal.md) | 锁屏后的发送链路、唤醒锁规则、自测步骤 |
| [phone-ui-redesign.md](docs/phone-ui-redesign.md) | 手机主页设计 |
| [band-readability.md](docs/band-readability.md) | 手环页的可读性设计 |
| [rpk-build.md](docs/rpk-build.md)、[package-identity.md](docs/package-identity.md) | RPK 构建与签名包身份核验 |
| [sdk-provenance.md](docs/sdk-provenance.md) | 官方 SDK 的来源、版本与哈希 |

其余是各阶段的实机记录与诊断说明，写法偏流水账，细节以代码和单测为准。

## 开发方式

这个仓库大部分代码由多智能体平台 CoAgentHub 按“规划 → 拆单 → 执行 → 验收”的流程写成，每一张票都有契约、验证命令和复核记录；`.coagent/` 里是这套流程的项目说明。需求和验收由人定，真机验证由人完成。

## 许可

本仓库的代码、文档和设计稿采用 [MIT 许可证](LICENSE)。不在此范围内的第三方内容遵循各自的条款：小米官方手机端 SDK 不随仓库分发（见 [docs/sdk-provenance.md](docs/sdk-provenance.md)），`gradle/wrapper/gradle-wrapper.jar` 来自 Gradle 项目（Apache-2.0）。
