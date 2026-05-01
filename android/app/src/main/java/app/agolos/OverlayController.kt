package app.agolos

import android.content.Context
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/**
 * Owns the floating overlay across two visible states:
 *
 *  - **Bubble** — small circular control. Auto-appears when AccessibilityService
 *    detects focus on an editable text field. Tap to enter expanded mode.
 *  - **Expanded** — full panel with cancel/waveform/confirm controls + live
 *    teletype transcript. Tap confirm = transcribe + insert + collapse to
 *    bubble. Tap cancel = drop recording, collapse to bubble.
 *
 * State machine:
 *   HIDDEN ──showBubble()──> BUBBLE ──tap──> EXPANDED ──tap mic──> RECORDING
 *      ↑                       ↑                                       │
 *      └──────hideBubble()─────┴──────────cancel/confirm───────────────┘
 *                                                                      │
 *                                                            tap confirm│
 *                                                                      ↓
 *                                                              TRANSCRIBING
 */
class OverlayController(private val service: WisprService) {

    private enum class State { HIDDEN, BUBBLE, EXPANDED, RECORDING, TRANSCRIBING }

    private val ctx: Context = service
    private val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private var bubbleView: FrameLayout? = null
    private var expandedView: LinearLayout? = null
    private var statusLabel: TextView? = null
    private var partialText: TextView? = null

    private var bubbleAttached = false
    private var expandedAttached = false

    @Volatile
    private var state: State = State.HIDDEN

    // ─── Audio + transcription ────────────────────────────────────────────
    private val pcmBuffer = ByteArrayOutputStream()
    private var audioRecord: AudioRecord? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var recorderJob: Job? = null
    private var snapshotJob: Job? = null
    private var inFlight = false
    private var lastPartial = ""

    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // ─── Public API ────────────────────────────────────────────────────────

    /** Called by AccessibilityService when an editable text field gets focus. */
    fun showBubble() {
        scope.launch {
            if (state == State.HIDDEN) {
                attachBubble()
                state = State.BUBBLE
            }
        }
    }

    /**
     * Called by AccessibilityService when focus is lost. Only hides if we're
     * not in the middle of a recording / transcription.
     */
    fun hideBubble() {
        scope.launch {
            if (state == State.BUBBLE) {
                detachBubble()
                state = State.HIDDEN
            }
            // While EXPANDED/RECORDING/TRANSCRIBING, ignore — let the user
            // finish their dictation cycle.
        }
    }

    /** Called from the foreground service shutdown. */
    fun teardown() {
        scope.launch {
            stopRecordingInternal(commit = false)
            detachExpanded()
            detachBubble()
            state = State.HIDDEN
        }
        scope.cancel()
        service.onOverlayClosed()
    }

    /** Manual entry-point for QS-tile / notification trigger. */
    fun startManualDictation() {
        scope.launch {
            if (state == State.HIDDEN) {
                attachBubble()
                state = State.BUBBLE
            }
            if (state == State.BUBBLE) {
                expand()
                startRecording()
            }
        }
    }

    // ─── State transitions ─────────────────────────────────────────────────

    private fun expand() {
        if (state == State.BUBBLE || state == State.HIDDEN) {
            attachExpanded()
            state = State.EXPANDED
        }
    }

    private fun collapseToBubble() {
        detachExpanded()
        state = State.BUBBLE
        if (!bubbleAttached) attachBubble()
    }

    // ─── Bubble view ───────────────────────────────────────────────────────

    private fun attachBubble() {
        if (bubbleAttached) return
        val saved = loadBubblePosition()
        val view = buildBubble()
        val params = WindowManager.LayoutParams(
            dp(56), dp(56),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = saved.x
            y = saved.y
        }
        bubbleParams = params
        attachDragHandler(view, params)
        attachLongPressHandler(view)
        try {
            wm.addView(view, params)
            bubbleView = view
            bubbleAttached = true
        } catch (e: Exception) {
            Log.e(TAG, "attachBubble failed (overlay permission?)", e)
        }
    }

    private var bubbleParams: WindowManager.LayoutParams? = null
    private val prefs by lazy {
        ctx.getSharedPreferences("agolos-overlay", Context.MODE_PRIVATE)
    }

    private data class BubblePos(val x: Int, val y: Int)

    private fun loadBubblePosition(): BubblePos {
        val metrics = ctx.resources.displayMetrics
        val defaultX = metrics.widthPixels - dp(76)
        val defaultY = metrics.heightPixels - dp(196)
        return BubblePos(
            x = prefs.getInt("bubble_x", defaultX),
            y = prefs.getInt("bubble_y", defaultY),
        )
    }

    private fun saveBubblePosition(x: Int, y: Int) {
        prefs.edit().putInt("bubble_x", x).putInt("bubble_y", y).apply()
    }

    /**
     * Combined touch handler:
     *
     *  - **Drag**: if movement exceeds slop, reposition the bubble; persist
     *    the new x/y to SharedPreferences on release.
     *  - **Long-press push-to-talk**: hold for ≥400ms without dragging →
     *    expand + start recording immediately. Release = stop and commit.
     *  - **Tap**: short press without drag/PTT → fall through to OnClick
     *    listener which does normal expand.
     */
    private fun attachDragHandler(view: View, params: WindowManager.LayoutParams) {
        val slop = android.view.ViewConfiguration.get(ctx).scaledTouchSlop
        val longPressMs = 400L
        var startTouchX = 0f
        var startTouchY = 0f
        var startWinX = 0
        var startWinY = 0
        var dragging = false
        var pushToTalkActive = false
        val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
        var pttRunnable: Runnable? = null

        view.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startTouchX = event.rawX
                    startTouchY = event.rawY
                    startWinX = params.x
                    startWinY = params.y
                    dragging = false
                    pushToTalkActive = false
                    // Schedule long-press → PTT
                    pttRunnable = Runnable {
                        if (!dragging && state == State.BUBBLE) {
                            pushToTalkActive = true
                            expand()
                            startRecording()
                        }
                    }
                    mainHandler.postDelayed(pttRunnable!!, longPressMs)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startTouchX
                    val dy = event.rawY - startTouchY
                    if (!dragging && (kotlin.math.abs(dx) > slop || kotlin.math.abs(dy) > slop)) {
                        dragging = true
                        pttRunnable?.let { mainHandler.removeCallbacks(it) }
                    }
                    if (dragging) {
                        params.x = (startWinX + dx).toInt()
                            .coerceIn(0, ctx.resources.displayMetrics.widthPixels - dp(56))
                        params.y = (startWinY + dy).toInt()
                            .coerceIn(0, ctx.resources.displayMetrics.heightPixels - dp(56))
                        try { wm.updateViewLayout(v, params) } catch (_: Exception) {}
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    pttRunnable?.let { mainHandler.removeCallbacks(it) }
                    when {
                        pushToTalkActive -> {
                            // Release while holding → commit
                            pushToTalkActive = false
                            stopRecordingInternal(commit = true)
                        }
                        dragging -> {
                            saveBubblePosition(params.x, params.y)
                        }
                        else -> {
                            // Plain tap — fall through to OnClick
                            v.performClick()
                        }
                    }
                    dragging = false
                    true
                }
                else -> false
            }
        }
    }

    /** No longer needed — long-press handled inside drag handler. */
    private fun attachLongPressHandler(view: View) { /* no-op */ }

    private fun detachBubble() {
        if (!bubbleAttached) return
        try { bubbleView?.let { wm.removeView(it) } } catch (_: Exception) {}
        bubbleView = null
        bubbleAttached = false
    }

    private fun buildBubble(): FrameLayout {
        // Belovik bubble: rounded square (16dp radius) on paper-pure with
        // a graphite Б watermark, whole bubble at 60% opacity.
        val outer = FrameLayout(ctx).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(16).toFloat()
                setColor(0xFFFCFAF6.toInt()) // paper-pure
                setStroke(dp(1), 0x1A15171A.toInt())
            }
            elevation = dp(8).toFloat()
            alpha = 0.6f
        }
        val icon = ImageView(ctx).apply {
            setImageResource(R.drawable.ic_agolos_a)
            setColorFilter(0xFFF22A37.toInt()) // signal red
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }
        outer.addView(icon)
        outer.setOnClickListener {
            if (state == State.BUBBLE) expand()
        }
        return outer
    }

    // ─── Expanded panel ────────────────────────────────────────────────────

    private fun attachExpanded() {
        if (expandedAttached) return
        val view = buildExpanded()
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = dp(120) // above keyboard area
        }
        try {
            wm.addView(view, params)
            expandedView = view
            expandedAttached = true
            // Also detach the bubble while expanded to keep the visual focused.
            detachBubble()
        } catch (e: Exception) {
            Log.e(TAG, "attachExpanded failed", e)
        }
    }

    private fun detachExpanded() {
        if (!expandedAttached) return
        try { expandedView?.let { wm.removeView(it) } } catch (_: Exception) {}
        expandedView = null
        expandedAttached = false
        statusLabel = null
        partialText = null
    }

    private fun buildExpanded(): LinearLayout {
        // Belovik expanded card: paper-pure light glass with soft 24dp radius.
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(24).toFloat()
                setColor(0xF5FCFAF6.toInt()) // paper-pure 96%
                setStroke(dp(1).coerceAtLeast(1), 0x1A15171A.toInt())
            }
            elevation = dp(14).toFloat()
            setPadding(dp(18), dp(16), dp(18), dp(16))
            minimumWidth = dp(320)
        }

        // Status row
        val statusRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val statusDot = View(ctx).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFF8A8E96.toInt()) // text-tertiary
            }
            layoutParams = LinearLayout.LayoutParams(dp(8), dp(8))
                .apply { marginEnd = dp(10) }
        }
        val statusTv = TextView(ctx).apply {
            text = "удерживайте чтобы записать"
            setTextColor(0xFF8A8E96.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            letterSpacing = 0.06f
            isAllCaps = true
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        statusRow.addView(statusDot)
        statusRow.addView(statusTv)
        card.addView(statusRow)
        statusLabel = statusTv

        // Live partial transcript (multi-line, scrolling read)
        val partial = TextView(ctx).apply {
            text = ""
            setTextColor(0xFF15171A.toInt()) // ink
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            maxLines = 3
            ellipsize = android.text.TextUtils.TruncateAt.START
            setPadding(0, dp(12), 0, dp(12))
            minimumWidth = dp(300)
            setLineSpacing(0f, 1.4f)
        }
        card.addView(partial)
        partialText = partial

        // Controls row: cancel | mic | confirm
        val controls = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, 0)
        }

        // No red — graphite for primary mic, soft surfaces for secondary buttons.
        // Mic is now a Belovik-Б watermark on a graphite square (60% alpha),
        // not the 🎤 emoji.
        val cancelBtn = circleButton("✕", 0xFFE8E5DD.toInt(), fg = 0xFF555A63.toInt()) { onCancelTap() }
        val micBtn = agolosSquareButton(big = true) { onMicTap() }
        val confirmBtn = circleButton("✓", 0xFFECEFEA.toInt(), fg = 0xFF5C7A5A.toInt()) { onConfirmTap() }

        controls.addView(cancelBtn)
        controls.addView(spacer(dp(24)))
        controls.addView(micBtn)
        controls.addView(spacer(dp(24)))
        controls.addView(confirmBtn)

        card.addView(controls)
        return card
    }

    private fun circleButton(
        label: String,
        bg: Int,
        fg: Int = 0xFFFFFFFF.toInt(),
        big: Boolean = false,
        onTap: () -> Unit,
    ): View {
        val size = if (big) dp(56) else dp(44)
        val tv = TextView(ctx).apply {
            text = label
            setTextColor(fg)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (big) 22f else 16f)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(bg)
            }
            layoutParams = LinearLayout.LayoutParams(size, size)
            isClickable = true
            isFocusable = true
            setOnClickListener { onTap() }
        }
        return tv
    }

    private fun spacer(width: Int): View {
        val v = View(ctx)
        v.layoutParams = LinearLayout.LayoutParams(width, 1)
        return v
    }

    /**
     * Mic-equivalent button: rounded square in paper-pure with the Belovik
     * «Б» mark centered in graphite, whole button at 60% opacity. Matches
     * the bubble visual language — same brand element.
     */
    private fun agolosSquareButton(big: Boolean, onTap: () -> Unit): View {
        val size = if (big) dp(56) else dp(44)
        val outer = FrameLayout(ctx).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(if (big) 16 else 12).toFloat()
                setColor(0xFFFCFAF6.toInt()) // paper-pure
                setStroke(dp(1), 0x1A15171A.toInt())
            }
            alpha = 0.6f
            layoutParams = LinearLayout.LayoutParams(size, size)
            isClickable = true
            isFocusable = true
            setOnClickListener { onTap() }
        }
        val icon = ImageView(ctx).apply {
            setImageResource(R.drawable.ic_agolos_a)
            setColorFilter(0xFFF22A37.toInt()) // signal red
            scaleType = ImageView.ScaleType.FIT_CENTER
            val pad = if (big) dp(12) else dp(10)
            setPadding(pad, pad, pad, pad)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
        }
        outer.addView(icon)
        return outer
    }

    // ─── Control taps ──────────────────────────────────────────────────────

    private fun onMicTap() {
        when (state) {
            State.EXPANDED -> startRecording()
            State.RECORDING -> stopRecordingInternal(commit = true)
            else -> {}
        }
    }

    private fun onCancelTap() {
        if (state == State.RECORDING) stopRecordingInternal(commit = false)
        scope.launch {
            collapseToBubble()
        }
    }

    private fun onConfirmTap() {
        if (state == State.RECORDING) stopRecordingInternal(commit = true)
    }

    private fun setStatus(state: State) {
        scope.launch {
            statusLabel?.text = when (state) {
                State.EXPANDED, State.HIDDEN, State.BUBBLE -> "удерживайте чтобы записать"
                State.RECORDING -> "запись · tap ✓ когда закончите"
                State.TRANSCRIBING -> "расшифровка…"
            }
        }
    }

    // ─── Recording ─────────────────────────────────────────────────────────

    private fun startRecording() {
        synchronized(pcmBuffer) { pcmBuffer.reset() }
        lastPartial = ""
        inFlight = false
        partialText?.text = ""

        val minBuf = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate, channelConfig, audioFormat,
                minBuf.coerceAtLeast(4096),
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "AudioRecord init failed", e)
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return }

        audioRecord = rec
        rec.startRecording()
        state = State.RECORDING
        setStatus(state)

        recorderJob = scope.launch(Dispatchers.IO) {
            val buf = ByteArray(minBuf.coerceAtLeast(4096))
            while (isActive && state == State.RECORDING) {
                val read = rec.read(buf, 0, buf.size)
                if (read > 0) synchronized(pcmBuffer) { pcmBuffer.write(buf, 0, read) }
            }
        }

        snapshotJob = scope.launch(Dispatchers.IO) {
            while (isActive && state == State.RECORDING) {
                delay(2_000)
                if (state != State.RECORDING || inFlight) continue
                inFlight = true
                try {
                    val snap = synchronized(pcmBuffer) { pcmBuffer.toByteArray() }
                    if (snap.size >= 4_000) {
                        val partial = transcribe(pcmToWav(snap, sampleRate), postprocess = false)
                        if (state == State.RECORDING && !partial.isNullOrBlank()) {
                            lastPartial = partial
                            withContext(Dispatchers.Main) {
                                partialText?.text = partial
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "snapshot failed", e)
                } finally {
                    inFlight = false
                }
            }
        }
    }

    private fun stopRecordingInternal(commit: Boolean) {
        val rec = audioRecord ?: return
        try { rec.stop(); rec.release() } catch (_: Exception) {}
        audioRecord = null
        recorderJob?.cancel()
        snapshotJob?.cancel()

        if (!commit) {
            state = State.EXPANDED
            setStatus(state)
            return
        }

        state = State.TRANSCRIBING
        setStatus(state)

        val pcm = synchronized(pcmBuffer) { pcmBuffer.toByteArray() }
        if (pcm.size < 4_000) {
            state = State.EXPANDED
            setStatus(state)
            return
        }

        scope.launch(Dispatchers.IO) {
            val clean = try {
                transcribe(pcmToWav(pcm, sampleRate), postprocess = true)
            } catch (e: Exception) {
                Log.e(TAG, "final transcribe failed", e); null
            }
            withContext(Dispatchers.Main) {
                if (!clean.isNullOrBlank()) {
                    partialText?.text = clean
                    val ok = WisprAccessibilityService.injectText(clean)
                    if (!ok) {
                        copyToClipboard(clean)
                        statusLabel?.text = "скопировано в буфер — long-press → Paste"
                    } else {
                        statusLabel?.text = "вставлено ✓"
                    }
                } else {
                    statusLabel?.text = "не распознано"
                }
                delay(900)
                collapseToBubble()
            }
        }
    }

    private fun copyToClipboard(text: String) {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("А-ГОЛОС", text))
    }

    // ─── PCM → WAV ─────────────────────────────────────────────────────────

    private fun pcmToWav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val out = ByteArrayOutputStream(pcm.size + 44)
        val totalDataLen = pcm.size + 36
        val byteRate = sampleRate * 2
        out.write("RIFF".toByteArray()); out.write(intLE(totalDataLen)); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); out.write(intLE(16))
        out.write(shortLE(1)); out.write(shortLE(1))
        out.write(intLE(sampleRate)); out.write(intLE(byteRate))
        out.write(shortLE(2)); out.write(shortLE(16))
        out.write("data".toByteArray()); out.write(intLE(pcm.size)); out.write(pcm)
        return out.toByteArray()
    }

    private fun intLE(v: Int) = byteArrayOf(
        (v and 0xff).toByte(), ((v shr 8) and 0xff).toByte(),
        ((v shr 16) and 0xff).toByte(), ((v shr 24) and 0xff).toByte(),
    )
    private fun shortLE(v: Int) = byteArrayOf((v and 0xff).toByte(), ((v shr 8) and 0xff).toByte())

    // ─── HTTP ──────────────────────────────────────────────────────────────

    private fun transcribe(wav: ByteArray, postprocess: Boolean): String? {
        val token = AuthStore.token(ctx) ?: run {
            // Should never happen — MainActivity gates on auth before
            // starting the service. But be defensive.
            android.util.Log.w("OverlayController", "no auth token; skipping transcribe")
            handleAuthExpired()
            return null
        }
        val style = StyleStore.get(ctx).raw
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "audio", "rec.wav",
                wav.toRequestBody("audio/wav".toMediaType()),
            )
            .addFormDataPart("postprocess", postprocess.toString())
            .addFormDataPart("language", "ru")
            .addFormDataPart("style", style)
            .build()

        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/transcribe")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        http.newCall(req).execute().use { res ->
            if (res.code == 401) {
                handleAuthExpired()
                return null
            }
            if (!res.isSuccessful) return null
            val text = res.body?.string() ?: return null
            val json = JSONObject(text)
            return if (postprocess) {
                json.optString("clean").ifBlank { json.optString("raw") }
            } else json.optString("raw")
        }
    }

    /**
     * Token is expired or revoked. Drop credentials and route the user
     * back to LoginActivity. Posted on the main looper because we may be
     * called from OkHttp's network thread.
     */
    private fun handleAuthExpired() {
        AuthStore.clear(ctx)
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            val intent = android.content.Intent(ctx, LoginActivity::class.java)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
            ctx.startActivity(intent)
        }
    }

    private fun dp(v: Int): Int =
        (v * ctx.resources.displayMetrics.density).toInt().coerceAtLeast(1)

    companion object { private const val TAG = "OverlayController" }
}
