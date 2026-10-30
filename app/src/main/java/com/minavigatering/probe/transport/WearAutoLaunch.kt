package com.minavigatering.probe.transport

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.minavigatering.probe.logging.LogStore
import com.minavigatering.probe.navigation.NavigationSettings
import com.xiaomi.xms.wearable.Wearable
import java.util.concurrent.atomic.AtomicInteger

/**
 * The one SDK glue point that auto-launches the band page (work order W-745).
 *
 * Decides nothing itself: the node comes from the shared [ProbeRuntime.transport], the input is
 * measured here and handed to the process-wide [WearAutoLaunchPolicy], and only a
 * [WearAutoLaunchDecision.Launch] reaches the SDK. Every outcome is one short line under [TAG],
 * mirrored into [NavigationSettings.lastAutoLaunchText]; node ids and exception message bodies
 * never reach a line, so the result can be collected as evidence.
 */
object WearAutoLaunch {

    private const val TAG = "MiRingWearLaunch"

    /** The launch task returned successfully. */
    private const val LINE_OK = "auto launch ok"

    /** The band node reports no installed app page, so nothing is launched. */
    private const val LINE_NOT_INSTALLED = "auto not-installed"

    /** Prefix of an SDK failure line; only the exception simple name follows it. */
    private const val PREFIX_FAIL = "auto launch fail:"

    /** Prefix of a skip line; the policy reason follows it. */
    private const val PREFIX_SKIPPED = "auto skipped:"

    /** The single decision maker for this process. */
    private val policy = WearAutoLaunchPolicy()

    /** Bumped when navigation ends, so a late success callback of an old session cannot fire. */
    private val launchEpoch = AtomicInteger()

    /**
     * One navigation-start signal. Resolves the node first: a known id continues immediately,
     * a missing one costs exactly one asynchronous refresh, never a blocking wait.
     */
    fun onNavigationStarted(context: Context, onLaunched: () -> Unit) {
        val appContext = context.applicationContext
        val transport = ProbeRuntime.transport(appContext)
        val known = transport.currentNodeId
        if (!known.isNullOrBlank()) {
            continueWithNode(appContext, known, onLaunched)
            return
        }
        transport.refreshNode { resolved -> continueWithNode(appContext, resolved, onLaunched) }
    }

    /** Navigation ended: the next session may launch again, and old callbacks are stale. */
    fun onNavigationEnded() {
        policy.onNavigationEnded()
        launchEpoch.incrementAndGet()
    }

    /** Measures the input, asks the policy, and only a Launch reaches the SDK. */
    private fun continueWithNode(context: Context, nodeId: String?, onLaunched: () -> Unit) {
        when (val decision = policy.onNavigationStarted(inputFor(context, nodeId))) {
            is WearAutoLaunchDecision.Skip -> record(context, PREFIX_SKIPPED + decision.reason)
            is WearAutoLaunchDecision.Launch -> checkInstalled(launchRequest(context, nodeId, onLaunched))
        }
    }

    /** One pending launch, stamped with the session epoch it belongs to at decision time. */
    private fun launchRequest(context: Context, nodeId: String?, onLaunched: () -> Unit) =
        LaunchRequest(context, nodeId.orEmpty(), launchEpoch.get(), onLaunched)

    /** Everything the policy needs, all measured at the moment of the signal. */
    private fun inputFor(context: Context, nodeId: String?): WearAutoLaunchInput {
        val settings = NavigationSettings(context)
        return WearAutoLaunchInput(
            settingOn = settings.autoLaunchBand,
            bridgeOn = settings.enabled,
            nodePresent = !nodeId.isNullOrBlank(),
            ackAgeMs = ackAgeMs(),
        )
    }

    /** Milliseconds since the newest band ack, or null when no ack was ever recorded. */
    private fun ackAgeMs(): Long? =
        RuntimeTimeline.shared.lastSeen(TimelineEvent.ACK_RECEIVED)
            ?.let { SystemClock.elapsedRealtime() - it.elapsedMs }

    /** Installed flag read only through listeners; a false or throwing call ends the attempt. */
    private fun checkInstalled(request: LaunchRequest) {
        try {
            Wearable.getNodeApi(request.context).isWearAppInstalled(request.nodeId)
                .addOnSuccessListener { installed -> onInstalled(request, installed == true) }
                .addOnFailureListener { error -> record(request.context, PREFIX_FAIL + error.javaClass.simpleName) }
        } catch (t: Throwable) {
            record(request.context, PREFIX_FAIL + t.javaClass.simpleName)
        }
    }

    private fun onInstalled(request: LaunchRequest, installed: Boolean) {
        if (!installed) {
            record(request.context, LINE_NOT_INSTALLED)
            return
        }
        launch(request)
    }

    /** Launch task read only through listeners; success marks the line and the epoch gate. */
    private fun launch(request: LaunchRequest) {
        try {
            Wearable.getNodeApi(request.context).launchWearApp(request.nodeId, WearLaunchPlan.LAUNCH_URI)
                .addOnSuccessListener { onLaunchOk(request) }
                .addOnFailureListener { error -> record(request.context, PREFIX_FAIL + error.javaClass.simpleName) }
        } catch (t: Throwable) {
            record(request.context, PREFIX_FAIL + t.javaClass.simpleName)
        }
    }

    /** A launch that still belongs to the current session continues into the retry scheduling. */
    private fun onLaunchOk(request: LaunchRequest) {
        record(request.context, LINE_OK)
        if (launchEpoch.get() == request.epoch) request.onLaunched()
    }

    /** One line per outcome, logged and mirrored into the settings snapshot. */
    private fun record(context: Context, line: String) {
        Log.i(TAG, line)
        LogStore.i(TAG, "自动拉起: $line")
        val settings = NavigationSettings(context)
        settings.lastAutoLaunchText = line
        settings.lastAutoLaunchAtMs = System.currentTimeMillis()
    }

    /** One pending launch: the node to open, the session it belongs to, and its follow-up. */
    private data class LaunchRequest(
        val context: Context,
        val nodeId: String,
        val epoch: Int,
        val onLaunched: () -> Unit,
    )
}
