# Android 依赖与 SDK 来源

本文件记录探针工程所用官方 SDK 的可追溯来源、版本与哈希，以及许可状态。
哈希与 URL 均为本机实测值，不是从文档转抄。

## 1. 官方示例 ZIP

| 项目 | 值 |
|---|---|
| 来源 URL | https://cdn.cnbj3-fusion.fds.api.mi-img.com/quickapp-vela/interconnect_dev_test_demo.zip |
| 大小 | 7059049 bytes |
| MD5 | `b0182aea9c900ec791cec350e8302e56` |
| SHA256 | `8e3d74eebda558e2bef45e32f0965c5b77ef939a06cdc55136929f9427a95ca7` |
| 本机核对命令 | `curl -s -o interconnect_dev_test_demo.zip <URL>` 后 `md5sum` / `sha256sum` |

ZIP 内容（本机 `unzip -l` 实测）含官方 demo APK、demo RPK、两版接口 PDF、`interconnect-demo` 前端工程与
`libs/xms-wearable-lib_1.4_release.aar`。**ZIP 内没有 LICENSE 文件**（`unzip -l ... | grep -i license` 无匹配，退出码 1），
因此本工程**不宣称已获得明确的再分发许可**，只记录来源与哈希；许可证核实属于上游待办。

ZIP、demo APK、demo RPK、demo keystore、PDF，以及从 ZIP 中提取的 AAR，**均不入库**（仓库不分发小米的文件，AAR 的获取方式见下一节）。

## 2. 本地使用的 AAR（不入库）

构建手机端需要这个 AAR，但仓库**不跟踪**它（`.gitignore` 忽略 `app/libs/*.aar`）：请自己从官方示例包取出，放到 `app/libs/`。

| 项目 | 值 |
|---|---|
| 本地路径 | `app/libs/xms-wearable-lib_1.4_release.aar`（需自行放入，已被 `.gitignore` 忽略） |
| 提取来源 | 上述 ZIP 内 `interconnect_dev_test_demo/libs/xms-wearable-lib_1.4_release.aar` |
| 大小 | 102453 bytes |
| SHA256 | `9c40fd1c5409bb948523d503af71e2978ae522c35636afe7d64f474c0f6bc195` |
| SDK 版本 | 1.4（`xms-wearable-lib_1.4_release`） |
| 校验脚本 | `python scripts/check-aar-hash.py`（不符或文件不存在则退出码 1） |

取得步骤：按第 1 节的 URL 下载 ZIP，解压后把 `interconnect_dev_test_demo/libs/xms-wearable-lib_1.4_release.aar` 复制到 `app/libs/`，再运行上面的校验脚本。

## 3. AAR 查询包与 SDK 接口

AAR 自带 `AndroidManifest.xml` 声明查询以下两个包：

- `com.mi.health`（小米运动健康）
- `com.xiaomi.wearable`

探针 `AndroidManifest.xml` 的 `<queries>` 同步声明这两个包。

本机用 `javap` 实测的 1.4 公共接口（`classes.jar`）：

- `com.xiaomi.xms.wearable.Wearable`：`getNodeApi` / `getAuthApi` / `getMessageApi` / `getServiceApi` / `getNotifyApi`
- `com.xiaomi.xms.wearable.message.MessageApi`：`sendMessage(String nodeId, byte[])`、`addListener`、`removeListener`
- `com.xiaomi.xms.wearable.node.NodeApi`：`getConnectedNodes()`、`isWearAppInstalled`、`launchWearApp`
- `com.xiaomi.xms.wearable.auth.AuthApi`：`checkPermission`、`requestPermission`
- `com.xiaomi.xms.wearable.auth.Permission`：常量 `DEVICE_MANAGER`、`NOTIFY`

## 4. MessageApi 与 NotifyApi 的区别

| 维度 | `MessageApi.sendMessage` | `NotifyApi.sendNotify` |
|---|---|---|
| 语义 | 自定义消息通道，发送任意字节负载 | 普通通知转发 |
| 本工程用途 | **是**。探针状态的唯一发送通道 | **禁用**。不用于探针数据 |
| 协议解析 | 由手环端按本工程协议解析 | 由系统通知界面呈现，无自定义协议 |
| 契约依据 | AC2 要求使用 SDK 自定义消息通道而非通知转发 | 通知转发被明确排除 |

已用源码检索确认：`app/src/` 内不存在 `NotifyApi` 或 `sendNotify` 调用，只有
`messageApi.sendMessage(target, utf8Bytes)`（`XiaomiWearableTransport.kt`）。

## 5. 构建工具链

| 组件 | 版本 / 来源 |
|---|---|
| Gradle Wrapper | 9.8.1，`distributionUrl=https://services.gradle.org/distributions/gradle-9.8.1-bin.zip` |
| `gradle-wrapper.jar` | https://github.com/gradle/gradle/raw/v9.8.1/gradle/wrapper/gradle-wrapper.jar |
| Android Gradle Plugin | `com.android.application` 9.4.1 |
| Kotlin Compose 插件 | `org.jetbrains.kotlin.plugin.compose` 2.2.20（不应用 `org.jetbrains.kotlin.android`） |
| Compose BOM | `androidx.compose:compose-bom:2026.09.00` |
| JDK | Temurin 21（AGP 9.x 运行要求） |
| compileSdk / targetSdk / minSdk | 36 / 36 / 26 |
