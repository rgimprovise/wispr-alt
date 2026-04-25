package com.wispralt.keyboard

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Accessibility service whose only job is to find the currently-focused
 * EditText in whatever app is foreground and insert text into it.
 *
 * This is the standard pattern Android dictation, password managers, and
 * translation utilities use. Requires the user to enable the service in
 * Settings → Accessibility (one-time, on first run).
 *
 * No event filtering / processing here — we don't react to events, we only
 * use the service as a foothold to call rootInActiveWindow when asked.
 */
class WisprAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* no-op */ }
    override fun onInterrupt() { /* no-op */ }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "accessibility service connected")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        Log.i(TAG, "accessibility service unbound")
        return super.onUnbind(intent)
    }

    private fun findFocusedEditableNode(): AccessibilityNodeInfo? {
        // Try input focus first, then accessibility focus.
        val input = findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (input != null && input.isEditable) return input
        val a11y = findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
        if (a11y != null && a11y.isEditable) return a11y
        // Fall back: walk root looking for the first editable focused node.
        val root = rootInActiveWindow ?: return null
        return root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
    }

    /**
     * Inserts `text` into the currently focused editable field. Replaces
     * any current selection if there is one, else inserts at the caret.
     * Returns true if a target field was found and the insertion was
     * accepted by the platform.
     */
    private fun performInsert(text: String): Boolean {
        val node = findFocusedEditableNode() ?: run {
            Log.w(TAG, "no editable focus")
            return false
        }
        // Strategy A: replace whole text. Loses pre-existing content — bad.
        // Strategy B: paste. Works in most apps; respects caret position
        //   AND existing selection. We put text on clipboard then call
        //   ACTION_PASTE on the focused node.
        val clipboard = applicationContext.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("wispr-alt", text))

        // Some apps (custom EditText impls) don't expose ACTION_PASTE.
        // Fall back to setting text via ACTION_SET_TEXT, appending to
        // existing content.
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

        /** Returns true if a focused field was found and the text inserted. */
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
