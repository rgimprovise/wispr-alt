package com.wispralt.keyboard

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Two responsibilities:
 *
 *  1. **Focus listener** — watch `typeViewFocused` events. When an editable
 *     node receives focus in any foreground app, ask the OverlayController
 *     to show its bubble. After a short period without editable-focus
 *     events, hide it again.
 *
 *  2. **Text injector** — `injectText(...)` finds the currently focused
 *     editable node and inserts text via ACTION_PASTE (clipboard-mediated)
 *     with ACTION_SET_TEXT fallback.
 *
 * The bubble auto-appearance is the UX mode users expect from Wispr Flow:
 * tap any text field → bubble appears → tap bubble → record → text is
 * inserted at the cursor. Manual triggers (QS tile, notification action)
 * remain as fallbacks if Accessibility isn't enabled yet.
 */
class WisprAccessibilityService : AccessibilityService() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val hideBubbleRunnable = Runnable { hideBubbleNow() }

    /** How long after the last editable-focus event before we hide bubble. */
    private val bubbleHideDelayMs = 5_000L

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val ev = event ?: return
        when (ev.eventType) {
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                val source = ev.source
                if (source != null && source.isEditable) {
                    onEditableFocused()
                }
                source?.recycle()
            }
        }
    }

    override fun onInterrupt() { /* no-op */ }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "accessibility service connected")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        mainHandler.removeCallbacks(hideBubbleRunnable)
        Log.i(TAG, "accessibility service unbound")
        return super.onUnbind(intent)
    }

    private fun onEditableFocused() {
        // Show the bubble (if hidden), reset the auto-hide timer.
        mainHandler.removeCallbacks(hideBubbleRunnable)
        WisprService.instance?.onEditableFocusDetected()
        mainHandler.postDelayed(hideBubbleRunnable, bubbleHideDelayMs)
    }

    private fun hideBubbleNow() {
        // Only auto-hide if user isn't actively recording. The OverlayController
        // ignores hide() while recording/transcribing.
        WisprService.instance?.onEditableFocusLost()
    }

    // ─── Text injection ────────────────────────────────────────────────────

    private fun findFocusedEditableNode(): AccessibilityNodeInfo? {
        val input = findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (input != null && input.isEditable) return input
        val a11y = findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
        if (a11y != null && a11y.isEditable) return a11y
        val root = rootInActiveWindow ?: return null
        return root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
    }

    private fun performInsert(text: String): Boolean {
        val node = findFocusedEditableNode() ?: run {
            Log.w(TAG, "no editable focus")
            return false
        }
        val clipboard = applicationContext.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("wispr-alt", text))

        val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        if (pasted) return true

        Log.w(TAG, "ACTION_PASTE refused, falling back to ACTION_SET_TEXT")
        val current = node.text?.toString() ?: ""
        val args = Bundle().apply {
            putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                current + text,
            )
        }
        return node.performAction(
            AccessibilityNodeInfo.ACTION_SET_TEXT,
            args,
        )
    }

    companion object {
        private const val TAG = "WisprA11yService"

        @Volatile
        var instance: WisprAccessibilityService? = null
            private set

        fun injectText(text: String): Boolean {
            val svc = instance ?: run {
                Log.w(TAG, "service not enabled")
                return false
            }
            return try {
                svc.performInsert(text)
            } catch (e: Exception) {
                Log.e(TAG, "injectText failed", e)
                false
            }
        }

        fun isEnabled(): Boolean = instance != null
    }
}
