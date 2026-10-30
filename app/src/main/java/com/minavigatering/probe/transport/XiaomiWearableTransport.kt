package com.minavigatering.probe.transport

import android.content.Context
import android.util.Log
import com.minavigatering.probe.logging.LogStore
import com.minavigatering.probe.protocol.BandStatusMessage
import com.minavigatering.probe.protocol.Message
import com.minavigatering.probe.protocol.NavCodec
import com.minavigatering.probe.protocol.NavProtocol
import com.minavigatering.probe.protocol.StateMessage
import com.xiaomi.xms.wearable.Wearable
import com.xiaomi.xms.wearable.auth.Permission
import com.xiaomi.xms.wearable.message.OnMessageReceivedListener
import com.xiaomi.xms.wearable.node.Node
import com.xiaomi.xms.wearable.service.OnServiceConnectionListener

/**
 * Result of one send attempt.
 *
 * There is deliberately no `Sent` case: handing the payload to the SDK only proves the
 * local channel accepted it. The page must show "连接中" / queued until the watch itself
 * answers, instead of faking delivery (work order W-618).
 */
sealed interface SendResult {
    /** The SDK channel took the payload; its `Task` result is still pending. */
    data class Queued(val nodeId: String, val messageId: String) : SendResult
    data class NoNode(val reason: String) : SendResult
    data class Failed(val reason: String) : SendResult
}

/** Async phases of one send, reported separately from the watch acknowledgement. */
sealed interface SendPhase {
    data class Queued(val messageId: String, val nodeId: String) : SendPhase
    data class TaskSucceeded(val messageId: String) : SendPhase
    data class TaskFailed(val messageId: String, val reason: String) : SendPhase
}

/**
 * Communication adapter around the official xms-wearable SDK 1.4.
 *
 * Uses the SDK *custom message* channel (`MessageApi.sendMessage`) rather than the plain
 * notification bridge; it deliberately does not reference `NotifyApi.sendNotify`.
 * See PROJECT_SPEC.md section 4, 通信适配 row.
 */
class XiaomiWearableTransport(private val context: Context) {

    private companion object {
        const val TAG = "MiRingTransport"
    }

    private val nodeApi = Wearable.getNodeApi(context)
    private val authApi = Wearable.getAuthApi(context)
    private val messageApi = Wearable.getMessageApi(context)
    private val serviceApi = Wearable.getServiceApi(context)

    @Volatile
    private var nodeId: String? = null

    /** Node the inbound listener is currently registered for; null when not listening. */
    @Volatile
    private var listeningNodeId: String? = null

    @Volatile
    private var inboundHandler: ((Message) -> Unit)? = null

    /**
     * Sink that receives the phone-channel diagnostics (work order W-625).
     *
     * It is the shared [ProbeSession] of the page, so host service, node, permission and
     * the last SDK error stay readable even when no navigation instruction is sent. It
     * only ever receives diagnostic lines — never a watch receipt.
     */
    @Volatile
    private var diagnostics: ProbeSession? = null

    @Volatile
    private var connectionListenerRegistered = false

    /**
     * Service-connection listener forwarded to the shared diagnostics state.
     *
     * [OnServiceConnectionListener] exposes only these two callbacks; neither of them
     * carries a status code, so none may be invented.
     */
    private val connectionListener = object : OnServiceConnectionListener {
        override fun onServiceConnected() {
            diagnostics?.onHostStatus("宿主服务已连接（onServiceConnected）")
        }

        override fun onServiceDisconnected() {
            diagnostics?.onHostStatus("宿主服务已断开（onServiceDisconnected）")
        }
    }

    private val listener = OnMessageReceivedListener { receivedNodeId, payload ->
        val handler = inboundHandler
        if (handler == null) {
            Log.w(TAG, "inbound message dropped: no handler registered")
            return@OnMessageReceivedListener
        }
        val decoded = try {
            NavCodec.decode(payload)
        } catch (t: Throwable) {
            Log.w(TAG, "inbound payload from $receivedNodeId could not be decoded: ${t.message}")
            return@OnMessageReceivedListener
        }
        // 手环周期性回传的自身显示状态：单独记日志，不进入指令回执逻辑。
        if (decoded is BandStatusMessage) {
            val status =
                "title=${decoded.title} 距离=${if (decoded.hasDistance) "有" else "无"} " +
                    "路名=${if (decoded.roadVisible) "有" else "无"} diag=${decoded.diagStatus} " +
                    "生命周期=${decoded.lifeText}${if (decoded.error.isNullOrBlank()) "" else " 错误=${decoded.error}"}"
            LogStore.i(TAG, "手环状态: $status")
            return@OnMessageReceivedListener
        }
        handler(decoded)
    }

    val currentNodeId: String?
        get() = nodeId

    /**
     * Attaches the shared diagnostics sink so the page can read the probe state.
     *
     * Passing null detaches it. The sink never receives a watch receipt.
     */
    fun attachDiagnostics(session: ProbeSession?) {
        diagnostics = session
    }

    /**
     * Records one SDK failure into the shared diagnostics.
     *
     * The SDK `Task` failure callbacks hand over an [Exception], not a `Status`, so only
     * the class name and the message are recorded: `getCode()` / `getStatus()` do not
     * exist on these exceptions and must not be called.
     */
    private fun recordFailure(error: Throwable?) {
        val simpleName = error?.javaClass?.simpleName ?: "未知异常"
        diagnostics?.onSdkError(simpleName, error?.message)
        LogStore.w(TAG, "SDK失败: $simpleName ${error?.message ?: ""}")
    }

    /** Mirrors one SDK failure into the permission line as well. */
    private fun recordPermissionFailure(error: Throwable?) {
        val simpleName = error?.javaClass?.simpleName ?: "未知异常"
        diagnostics?.onPermissionStatus("权限探测失败：$simpleName")
        LogStore.w(TAG, "权限探测失败: $simpleName ${error?.message ?: ""}")
    }

    /** Refreshes the reachable node list asynchronously; the callback gets the first node. */
    fun refreshNode(onResult: (String?) -> Unit) {
        try {
            nodeApi.getConnectedNodes()
                .addOnSuccessListener { nodes: List<Node>? ->
                    val first = nodes?.firstOrNull()
                    val resolved = first?.id
                    nodeId = resolved
                    val name = first?.name
                    val namePart = if (name.isNullOrBlank()) "" else " name=$name"
                    val nodeLine = if (resolved.isNullOrBlank()) {
                        "节点 id 为空（无可发送节点）$namePart"
                    } else {
                        "节点 id 非空$namePart"
                    }
                    diagnostics?.onNodeStatus(nodeLine)
                    LogStore.i(TAG, "节点: $nodeLine")
                    onResult(resolved)
                }
                .addOnFailureListener { error ->
                    Log.w(TAG, "getConnectedNodes failed: ${error.message}")
                    nodeId = null
                    recordFailure(error)
                    val nodeLine = "节点获取失败：${error.javaClass.simpleName}"
                    diagnostics?.onNodeStatus(nodeLine)
                    LogStore.w(TAG, "节点: $nodeLine")
                    onResult(null)
                }
        } catch (t: Throwable) {
            Log.w(TAG, "getConnectedNodes threw: ${t.message}")
            nodeId = null
            recordFailure(t)
            diagnostics?.onNodeStatus("节点获取抛出：${t.javaClass.simpleName}")
            onResult(null)
        }
    }

    /**
     * Queries the host service API level without reading the unfinished `Task`.
     *
     * The level (or the failure reason) is only known through the listeners; reading
     * `isSuccessful` right after the call would report a wrong answer.
     */
    fun queryServiceApiLevel(onResult: (Int?, String?) -> Unit) {
        try {
            serviceApi.getServiceApiLevel()
                .addOnSuccessListener { level ->
                    diagnostics?.onHostStatus("宿主服务 API level=${level ?: "未知"}")
                    onResult(level, null)
                }
                .addOnFailureListener { error ->
                    Log.w(TAG, "getServiceApiLevel failed: ${error.message}")
                    recordFailure(error)
                    val name = error.javaClass.simpleName
                    diagnostics?.onHostStatus("宿主服务 API level 查询失败：$name")
                    onResult(null, name)
                }
        } catch (t: Throwable) {
            Log.w(TAG, "getServiceApiLevel threw: ${t.message}")
            recordFailure(t)
            diagnostics?.onHostStatus("宿主服务 API level 查询抛出：${t.javaClass.simpleName}")
            onResult(null, t.javaClass.simpleName)
        }
    }

    /**
     * Registers the host-service connection listener once.
     *
     * The connected/disconnected events go to the same diagnostics state as the rest of
     * the probe. Call [unregisterDiagnostics] when the page goes away, otherwise every
     * page entry would stack another listener.
     */
    fun registerDiagnostics() {
        if (connectionListenerRegistered) return
        try {
            serviceApi.registerServiceConnectionListener(connectionListener)
            connectionListenerRegistered = true
        } catch (t: Throwable) {
            Log.w(TAG, "registerServiceConnectionListener threw: ${t.message}")
            recordFailure(t)
        }
    }

    /** Removes the host-service connection listener registered by [registerDiagnostics]. */
    fun unregisterDiagnostics() {
        if (!connectionListenerRegistered) return
        connectionListenerRegistered = false
        try {
            serviceApi.unregisterServiceConnectionListener(connectionListener)
        } catch (t: Throwable) {
            Log.w(TAG, "unregisterServiceConnectionListener threw: ${t.message}")
        }
    }

    /**
     * Checks whether the custom-message channel already holds the device-manager
     * permission.
     *
     * Without a known node id the SDK must not be called at all; the callback then gets
     * the explicit "no node" text instead of a fabricated result.
     */
    fun checkDeviceManagerPermission(onResult: (Boolean?, String) -> Unit) {
        val target = nodeId?.trim()
        if (target.isNullOrEmpty()) {
            diagnostics?.onPermissionStatus(ProbeSession.NO_NODE_CHECK_TEXT)
            onResult(null, ProbeSession.NO_NODE_CHECK_TEXT)
            return
        }
        try {
            authApi.checkPermission(target, Permission.DEVICE_MANAGER)
                .addOnSuccessListener { granted ->
                    val value = granted ?: false
                    val text = if (value) "设备管理权限：已授予" else "设备管理权限：未授予"
                    diagnostics?.onPermissionStatus(text)
                    LogStore.i(TAG, "权限检查: $text")
                    onResult(value, text)
                }
                .addOnFailureListener { error ->
                    Log.w(TAG, "checkPermission failed: ${error.message}")
                    recordFailure(error)
                    recordPermissionFailure(error)
                    val text = "权限检查失败：${error.javaClass.simpleName}"
                    onResult(null, text)
                }
        } catch (t: Throwable) {
            Log.w(TAG, "checkPermission threw: ${t.message}")
            recordFailure(t)
            recordPermissionFailure(t)
            val text = "权限检查抛出：${t.javaClass.simpleName}"
            onResult(null, text)
        }
    }

    /**
     * Requests the permission the SDK custom-message channel needs.
     *
     * Without a known node id the SDK must not be called: passing an empty id to the
     * native side would be a fabricated request. The callback carries the granted flag
     * **and** the failure class name, so a failure cannot collapse into a bare `false`.
     */
    fun requestDeviceManagerPermission(onResult: (Boolean, String) -> Unit) {
        val target = nodeId?.trim()
        if (target.isNullOrEmpty()) {
            diagnostics?.onPermissionStatus(ProbeSession.NO_NODE_REQUEST_TEXT)
            onResult(false, ProbeSession.NO_NODE_REQUEST_TEXT)
            return
        }
        try {
            authApi.requestPermission(target, Permission.DEVICE_MANAGER)
                .addOnSuccessListener { granted ->
                    val value = granted != null && granted.isNotEmpty()
                    val text = if (value) "设备管理权限：已授予" else "设备管理权限：未授予"
                    diagnostics?.onPermissionStatus(text)
                    LogStore.i(TAG, "权限请求结果: $text")
                    onResult(value, text)
                }
                .addOnFailureListener { error ->
                    Log.w(TAG, "permission request failed: ${error.message}")
                    recordFailure(error)
                    recordPermissionFailure(error)
                    val text = "权限请求失败：${error.javaClass.simpleName}"
                    LogStore.w(TAG, "权限请求: $text")
                    onResult(false, text)
                }
        } catch (t: Throwable) {
            Log.w(TAG, "permission request threw: ${t.message}")
            recordFailure(t)
            recordPermissionFailure(t)
            val text = "权限请求抛出：${t.javaClass.simpleName}"
            LogStore.w(TAG, "权限请求: $text")
            onResult(false, text)
        }
    }

    /** Registers the handler that receives decoded *real* watch messages. */
    fun setInboundHandler(handler: (Message) -> Unit) {
        inboundHandler = handler
    }

    /**
     * Registers the SDK message listener for the current node.
     *
     * Does nothing without a node, and re-registers only when the node changed; a node
     * switch removes the old registration first.
     */
    fun ensureListening() {
        val target = nodeId
        if (target == null) {
            Log.w(TAG, "ensureListening skipped: no connected watch node")
            return
        }
        if (listeningNodeId == target) return
        val previous = listeningNodeId
        listeningNodeId = target
        try {
            if (previous != null && previous != target) {
                messageApi.removeListener(previous)
                    .addOnFailureListener { error ->
                        Log.w(TAG, "removeListener($previous) failed: ${error.message}")
                    }
            }
            messageApi.addListener(target, listener)
                .addOnFailureListener { error ->
                    Log.w(TAG, "addListener($target) failed: ${error.message}")
                }
        } catch (t: Throwable) {
            Log.w(TAG, "listener registration threw: ${t.message}")
            listeningNodeId = previous
        }
    }

    /** Unregisters the SDK message listener for the current node. */
    fun stopListening() {
        val target = listeningNodeId
        listeningNodeId = null
        if (target == null) return
        try {
            messageApi.removeListener(target)
                .addOnFailureListener { error ->
                    Log.w(TAG, "removeListener($target) failed: ${error.message}")
                }
        } catch (t: Throwable) {
            Log.w(TAG, "removeListener threw: ${t.message}")
        }
    }

    /**
     * Sends any protocol message over the SDK custom message channel.
     *
     * Returns [SendResult.Queued] as soon as the channel accepted the payload. The SDK
     * `Task` outcome arrives later through [onPhase]; no success is reported earlier.
     */
    fun send(message: Message, onPhase: (SendPhase) -> Unit = {}): SendResult {
        val target = nodeId ?: return SendResult.NoNode("no connected watch node")
        val payload = NavCodec.encode(message)
        return try {
            val task = messageApi.sendMessage(target, payload)
            onPhase(SendPhase.Queued(message.id, target))
            task.addOnSuccessListener {
                onPhase(SendPhase.TaskSucceeded(message.id))
            }
                .addOnFailureListener { error ->
                    val reason = error.message ?: "task failed"
                    Log.w(TAG, "sendMessage failed: $reason")
                    LogStore.w(TAG, "发送失败: id=${message.id} reason=$reason")
                    onPhase(SendPhase.TaskFailed(message.id, reason))
                }
            SendResult.Queued(target, message.id)
        } catch (t: Throwable) {
            SendResult.Failed(t.message ?: "sendMessage threw")
        }
    }

    fun sendState(state: StateMessage, onPhase: (SendPhase) -> Unit = {}): SendResult =
        send(state, onPhase)
}

/** Builds a heartbeat copy of the current state; it never carries a new instruction. */
fun heartbeatOf(state: StateMessage, nowMs: Long): StateMessage = state.copy(
    id = "hb-$nowMs",
    sentAtMs = nowMs,
    heartbeat = true,
    link = NavProtocol.LINK_CONNECTED,
)
