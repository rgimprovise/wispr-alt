package com.wispralt.keyboard

import android.content.Context
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
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
 * Floating overlay pill: appears over the foreground app (Telegram, Notes,
 * browser, …) while wispr-alt records and transcribes. On stop, the cleaned
 * transcript is delivered to WisprAccessibilityService, which inserts it
 * into the focused EditText of whatever app is in front.
 *
 * Lifecycle owned by WisprService. attach() adds the overlay view to the
 * WindowManager; detach() removes it.
 */
class OverlayController(private val service: WisprService) {

    private enum class State { IDLE, RECORDING, TRANSCRIBING }

    private val ctx: Context = service
    private val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private var rootView: LinearLayout? = null
    private var statusDot: View? = null
    private var statusText: TextView? = null

    private var attached = false

    // ─── Audio + transcription ────────────────────────────────────────────
    private val pcmBuffer = ByteArrayOutputStream()
    private var audioRecord: AudioRecord? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var recorderJob: Job? = null
    private var snapshotJob: Job? = null
    private var inFlight = false
    private var lastPartial = ""
    private var state = State.IDLE

    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // ─── Window attach / detach ────────────────────────────────────────────

    fun attach() {
        if (attached) return
        rootView = buildView()

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // FLAG_NOT_FOCUSABLE so we don't steal focus from the app the
            // user is typing into. FLAG_LAYOUT_NO_LIMITS lets the pill
            // sit in the status-bar area near the top.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                or WindowManager.LayoutParams.FLAG_LAYOUT_INSET_DECOR,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(20)
        }
        try {
            wm.addView(rootView, params)
            attached = true
        } catch (e: Exception) {
            Log.e(TAG, "addView failed (overlay permission?)", e)
        }
    }

    fun detach() {
        stopRecording(commit = false)
        if (attached && rootView != null) {
            try { wm.removeView(rootView) } catch (_: Exception) {}
            attached = false
            rootView = null
        }
        scope.cancel()
        service.onOverlayClosed()
    }

    // ─── Build view ────────────────────────────────────────────────────────

    private fun buildView(): LinearLayout {
        val pill = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(28).toFloat()
                setColor(0xE6121214.toInt()) // semi-translucent dark
                setStroke(dp(1), 0x33FFFFFF.toInt())
            }
            setPadding(dp(16), dp(10), dp(16), dp(10))
            elevation = dp(8).toFloat()
        }

        val dot = View(ctx).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFFEF4444.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(dp(10), dp(10))
                .apply { marginEnd = dp(10) }
        }
        statusDot = dot
        pill.addView(dot)

        val label = TextView(ctx).apply {
            text = "слушаю…"
            setTextColor(0xFFF5F5F4.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(
                dp(280),
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        statusText = label
        pill.addView(label)

        // Tapping the pill stops recording + finalizes
        pill.setOnClickListener {
            when (state) {
                State.RECORDING -> stopRecording(commit = true)
                State.IDLE -> startDictation()
                State.TRANSCRIBING -> {} // ignore
            }
        }

        return pill
    }

    // ─── Dictation flow ────────────────────────────────────────────────────

    fun startDictation() {
        if (state == State.RECORDING) return
        if (state == State.TRANSCRIBING) return
        startRecording()
    }

    private fun setState(next: State) {
        state = next
        scope.launch {
            statusText?.text = when (next) {
                State.IDLE -> "tap чтобы начать"
                State.RECORDING -> "слушаю — tap чтобы закончить"
                State.TRANSCRIBING -> "распознаю…"
            }
            val color = when (next) {
                State.IDLE -> 0xFF6B7280.toInt()
                State.RECORDING -> 0xFFEF4444.toInt()
                State.TRANSCRIBING -> 0xFFF59E0B.toInt()
            }
            (statusDot?.background as? GradientDrawable)?.setColor(color)
        }
    }

    private fun startRecording() {
        synchronized(pcmBuffer) { pcmBuffer.reset() }
        lastPartial = ""
        inFlight = false

        val minBuf = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                channelConfig,
                audioFormat,
                minBuf.coerceAtLeast(4096),
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "AudioRecord init failed", e)
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return }

        audioRecord = rec
        rec.startRecording()
        setState(State.RECORDING)

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
                                // Show the latest partial in the pill (truncated to fit)
                                statusText?.text = partial
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

    private fun stopRecording(commit: Boolean) {
        val rec = audioRecord ?: return
        try { rec.stop(); rec.release() } catch (_: Exception) {}
        audioRecord = null
        recorderJob?.cancel()
        snapshotJob?.cancel()

        if (!commit) {
            setState(State.IDLE)
            scope.launch {
                delay(150)
                detach()
            }
            return
        }

        setState(State.TRANSCRIBING)

        val pcm = synchronized(pcmBuffer) { pcmBuffer.toByteArray() }
        if (pcm.size < 4_000) {
            setState(State.IDLE)
            scope.launch { delay(300); detach() }
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
                    statusText?.text = clean.take(60)
                    val ok = WisprAccessibilityService.injectText(clean)
                    if (!ok) {
                        Log.w(TAG, "no focused field — text only on clipboard")
                        copyToClipboard(clean)
                        statusText?.text = "скопировано в буфер — long-press → Paste"
                    }
                } else {
                    statusText?.text = "не распознано"
                }
                delay(900)
                detach()
            }
        }
    }

    private fun copyToClipboard(text: String) {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE)
                as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("wispr-alt", text))
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
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "audio", "rec.wav",
                wav.toRequestBody("audio/wav".toMediaType()),
            )
            .addFormDataPart("postprocess", postprocess.toString())
            .addFormDataPart("language", "ru")
            .build()

        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/transcribe")
            .post(body)
            .build()

        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return null
            val text = res.body?.string() ?: return null
            val json = JSONObject(text)
            return if (postprocess) {
                json.optString("clean").ifBlank { json.optString("raw") }
            } else json.optString("raw")
        }
    }

    private fun dp(v: Int): Int =
        (v * ctx.resources.displayMetrics.density).toInt().coerceAtLeast(1)

    companion object { private const val TAG = "OverlayController" }
}
