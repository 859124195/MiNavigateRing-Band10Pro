package com.minavigatering.probe.logging

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import com.minavigatering.probe.transport.RuntimeTimeline
import com.minavigatering.probe.transport.TimelineEntry
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 手机端持久化运行日志（工作项：内置日志）。
 *
 * 设计目标：把"手机侧发生的一切"落盘到应用私有文件，进程退出也不丢，并且能在 App 内
 * 直接查看、复制、分享。这样不用连电脑抓 logcat，在手机上就能判断导航桥哪一步错了
 * （例如手环黑屏时，权限被拒 / 自动拉起失败 / SDK 任务失败都会写在这里）。
 *
 * 与现有 RuntimeTimeline 的关系：Timeline 是脱敏的内存环形缓冲（进程退出即丢），本类是它的
 * 持久化镜像 + 一组显式业务日志（权限、节点、SDK 失败、自动拉起）。两者不重复记录同一事件，
 * 只通过 RuntimeTimeline 的 observer 把时间线事件镜像到文件。
 *
 * 线程安全：所有对内存环与文件的写都在 [lock] 内完成；日期格式用 ThreadLocal 避免并发问题。
 */
object LogStore {

    private const val FILE_NAME = "probelog.txt"
    private const val MAX_RING_LINES = 3000
    private const val MAX_FILE_BYTES = 400_000L
    private const val FILE_PROVIDER_AUTHORITY = "com.minavigatering.probe.fileprovider"

    private val dateFmt = ThreadLocal.withInitial {
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
    }

    private val lock = Any()
    private val ring = ArrayDeque<String>(MAX_RING_LINES)
    private var file: File? = null
    private var writer: BufferedWriter? = null
    private val initialized = AtomicBoolean(false)

    /** 在 Application/Activity/Service 启动时调用一次；可重复调用，幂等。 */
    fun init(context: Context) {
        if (initialized.getAndSet(true)) return
        synchronized(lock) {
            file = File(context.applicationContext.filesDir, FILE_NAME)
            try {
                writer = BufferedWriter(FileWriter(file, true))
            } catch (_: Throwable) {
                writer = null
            }
        }
    }

    fun log(level: LogLevel, tag: String, message: String) {
        val line = buildLine(level, tag, message)
        synchronized(lock) {
            ring.addLast(line)
            while (ring.size > MAX_RING_LINES) ring.removeFirst()
            try {
                writer?.apply {
                    write(line)
                    write("\n")
                    flush()
                }
            } catch (_: Throwable) {
                // 写文件失败不影响内存环与调用方。
            }
        }
        maybeRotate()
    }

    fun d(tag: String, msg: String) = log(LogLevel.DEBUG, tag, msg)
    fun i(tag: String, msg: String) = log(LogLevel.INFO, tag, msg)
    fun w(tag: String, msg: String) = log(LogLevel.WARN, tag, msg)
    fun e(tag: String, msg: String) = log(LogLevel.ERROR, tag, msg)

    /** 把一条 RuntimeTimeline 事件镜像成一行日志（同时保留原 Log.i MiRingTimeline 行为）。 */
    fun logTimeline(entry: TimelineEntry) {
        val wall = dateFmt.get().format(Date(entry.timestamp.wallMs))
        val line = "$wall +${entry.timestamp.elapsedMs}ms ${entry.event} ${entry.detail}"
        android.util.Log.i("MiRingTimeline", line)
        log(LogLevel.INFO, "TIMELINE", line)
    }

    /** 安装为 RuntimeTimeline 的唯一 observer（幂等：多次调用设同一个 lambda）。 */
    fun installTimelineSink() {
        RuntimeTimeline.shared.setObserver { logTimeline(it) }
    }

    /** 当前内存环的快照（新到旧顺序的反转：最新在末尾）。UI 每秒读取一次。 */
    fun recentLines(): List<String> = synchronized(lock) { ArrayList(ring) }

    fun allText(): String = synchronized(lock) { ring.joinToString("\n") }

    fun clear(context: Context) {
        synchronized(lock) {
            ring.clear()
            try {
                writer?.close()
            } catch (_: Throwable) {
            }
            writer = null
            file?.delete()
            try {
                writer = BufferedWriter(FileWriter(file, false))
            } catch (_: Throwable) {
                writer = null
            }
        }
    }

    /** 供"分享/导出"使用的 content:// URI；失败返回 null。 */
    fun exportUri(context: Context): Uri? {
        init(context)
        val f = file ?: return null
        return try {
            FileProvider.getUriForFile(context.applicationContext, FILE_PROVIDER_AUTHORITY, f)
        } catch (_: Throwable) {
            null
        }
    }

    private fun buildLine(level: LogLevel, tag: String, message: String): String {
        val ts = dateFmt.get().format(Date())
        return "$ts ${level.name.first()} $tag: $message"
    }

    /** 文件超过上限时，用当前内存环重写（内存环本身已截断）。 */
    private fun maybeRotate() {
        synchronized(lock) {
            val f = file ?: return
            if (f.length() <= MAX_FILE_BYTES) return
            try {
                writer?.close()
                FileWriter(f, false).use { w -> ring.forEach { w.write(it + "\n") } }
                writer = BufferedWriter(FileWriter(f, true))
            } catch (_: Throwable) {
            }
        }
    }
}

enum class LogLevel { DEBUG, INFO, WARN, ERROR }
