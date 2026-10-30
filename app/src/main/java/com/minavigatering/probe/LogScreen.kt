package com.minavigatering.probe

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.minavigatering.probe.logging.LogLevel
import com.minavigatering.probe.logging.LogStore
import kotlinx.coroutines.delay

/**
 * 手机端运行日志查看页（内置日志工作项）。
 *
 * 从 [LogStore] 读取持久化日志，支持：按级别筛选、自动滚到底部、清空、一键分享（把日志文件
 * 通过系统分享面板发出，便于直接发给我看）。每秒刷新一次，和现有诊断页节奏一致。
 */
@Composable
fun LogScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var rawLines by remember { mutableStateOf(LogStore.recentLines()) }
    var filter by remember { mutableStateOf(LogLevelFilter.ALL) }
    var autoScroll by remember { mutableStateOf(true) }

    val listState = rememberLazyListState()

    LaunchedEffect(Unit) {
        while (true) {
            rawLines = LogStore.recentLines()
            delay(1000)
        }
    }

    val visible = remember(rawLines, filter) {
        if (filter == LogLevelFilter.ALL) rawLines else rawLines.filter { lineLevel(it) >= filter.minLevel }
    }

    LaunchedEffect(visible.size, autoScroll) {
        if (autoScroll && visible.isNotEmpty()) {
            listState.scrollToItem(visible.size - 1)
        }
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        // 顶部操作栏：返回 / 清空 / 分享。
        Row(
            Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(onClick = onBack) { Text("返回导航") }
            OutlinedButton(onClick = {
                LogStore.clear(context)
                rawLines = emptyList()
            }) { Text("清空") }
            OutlinedButton(onClick = {
                val uri = LogStore.exportUri(context)
                if (uri != null) {
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(Intent.createChooser(intent, "分享运行日志"))
                }
            }) { Text("分享") }
            Text(
                "共 ${visible.size} 行",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
        }

        // 级别筛选 chips。
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LogLevelFilter.entries.forEach { f ->
                FilterChip(
                    selected = filter == f,
                    onClick = { filter = f },
                    label = { Text(f.label) },
                )
            }
            FilterChip(
                selected = autoScroll,
                onClick = { autoScroll = !autoScroll },
                label = { Text(if (autoScroll) "自动滚动:开" else "自动滚动:关") },
            )
        }

        if (visible.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("尚无日志。先把玩一下导航桥，事件会出现在这里。", style = MaterialTheme.typography.bodyMedium)
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 10.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                items(visible, key = { it }) { line ->
                    Text(
                        line,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Normal,
                        color = lineColor(line),
                    )
                }
            }
        }
    }
}

/** 日志级别筛选。minLevel 越大越严重，便于"只看错误"。 */
private enum class LogLevelFilter(val label: String, val minLevel: LogLevel) {
    ALL("全部", LogLevel.DEBUG),
    ERROR("错误", LogLevel.ERROR),
    WARN("警告", LogLevel.WARN),
    INFO("信息", LogLevel.INFO),
    DEBUG("调试", LogLevel.DEBUG),
}

/** 从一行日志里读出级别字符（格式见 LogStore.buildLine：时间戳后空格后的那个字母）。 */
private fun lineLevel(line: String): LogLevel {
    return when (line.getOrNull(23)) {
        'E' -> LogLevel.ERROR
        'W' -> LogLevel.WARN
        'I' -> LogLevel.INFO
        'D' -> LogLevel.DEBUG
        else -> LogLevel.DEBUG
    }
}

/** 按级别上色：错误红、警告橙、信息浅、调试灰。 */
private fun lineColor(line: String): Color = when (line.getOrNull(23)) {
    'E' -> Color(0xFFEF5350)
    'W' -> Color(0xFFFFB300)
    'I' -> Color(0xFFB0BEC5)
    else -> Color(0xFF90A4AE)
}
