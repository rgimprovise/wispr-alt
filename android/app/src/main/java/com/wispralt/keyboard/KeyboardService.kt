package com.wispralt.keyboard

import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.inputmethodservice.InputMethodService
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
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
 * wispr-alt soft keyboard IME with live dictation.
 *
 * Visual: Gboard-style dark keyboard. Slim status bar on top, three letter
 * rows (QWERTY or ЙЦУКЕН) with proper weighted distribution, bottom row with
 * lang switch / globe / wide mic / space / enter.
 *
 * Dictation: while recording, every 2s a snapshot of the accumulated PCM is
 * POSTed to the backend with postprocess=false (raw Whisper). The partial
 * transcript is shown via InputConnection.setComposingText() — appears as
 * underlined preliminary text in the user's app, replaceable on each tick.
 * When the user taps mic again, we send the full WAV with postprocess=true,
 * receive the LLM-cleaned text, and call commitText() — replaces the
 * composing region with the final clean version.
 */
class KeyboardService : InputMethodService() {

    // ─── State ─────────────────────────────────────────────────────────────
    private enum class Lang { EN, RU }
    private enum class RecState { IDLE, RECORDING, TRANSCRIBING }

    private var currentLang = Lang.EN
    private var shiftOn = false
    private var recState = RecState.IDLE

    // PCM buffer accumulated during recording. Mutex'd via @Synchronized.
    private val pcmBuffer = ByteArrayOutputStream()
    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private var snapshotJob: Job? = null

    private var snapshotInFlight = false
    private var lastPartial = ""

    // ─── UI refs ───────────────────────────────────────────────────────────
    private var rootView: LinearLayout? = null
    private var statusLabel: TextView? = null
    private var keyboardArea: LinearLayout? = null
    private var micKey: TextView? = null

    // ─── Coroutines / HTTP ─────────────────────────────────────────────────
    private val scope = CoroutineScope(Dispatchers.IO)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // ─── Theme palette (Gboard-dark inspired) ──────────────────────────────
    private object Pal {
        const val BG          = 0xFF1F1F1F.toInt()
        const val KEY_BG      = 0xFF3C4043.toInt()
        const val KEY_BG_PRESS = 0xFF5F6368.toInt()
        const val KEY_FG      = 0xFFE8EAED.toInt()
        const val KEY_FG_DIM  = 0xFFB8BCBF.toInt()
        const val MOD_BG      = 0xFF2D2F31.toInt()        // Shift / Backspace
        const val MIC_BG      = 0xFFEF4444.toInt()
        const val MIC_BG_REC  = 0xFFDC2626.toInt()
        const val MIC_BG_PROC = 0xFFF59E0B.toInt()
        const val STATUS_FG   = 0xFF8A8E91.toInt()
    }

    // ─── Layouts ───────────────────────────────────────────────────────────
    private val rowsEN = listOf(
        "qwertyuiop",
        "asdfghjkl",
        "zxcvbnm",
    )
    private val rowsRU = listOf(
        "йцукенгшщзх",
        "фывапролджэ",
        "ячсмитьбю",
    )

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    override fun onCreateInputView(): View {
        val ctx = this

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Pal.BG)
            setPadding(dp(4), dp(6), dp(4), dp(8))
        }
        rootView = root

        // Status strip (top)
        val status = TextView(ctx).apply {
            text = "wispr-alt"
            setTextColor(Pal.STATUS_FG)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setPadding(dp(8), dp(2), dp(8), dp(4))
            ellipsize = TextUtils.TruncateAt.END
            maxLines = 1
        }
        root.addView(status)
        statusLabel = status

        // Keyboard container
        val area = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        root.addView(area)
        keyboardArea = area

        rebuildKeyboard()
        return root
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        // Reset transient state on new field
        if (recState != RecState.IDLE) stopRecording(commit = false)
        lastPartial = ""
    }

    override fun onFinishInput() {
        super.onFinishInput()
        if (recState != RecState.IDLE) stopRecording(commit = false)
    }

    // ─── Build keyboard ────────────────────────────────────────────────────

    /**
     * Each row is a horizontal LinearLayout that fills the full width.
     * Letter buttons use weight=1 to share space evenly within their row.
     * Modifier buttons (Shift/Backspace) get weight=1.5 so they're a touch
     * wider, like a real mobile keyboard.
     */
    private fun rebuildKeyboard() {
        val area = keyboardArea ?: return
        area.removeAllViews()

        val rows = if (currentLang == Lang.EN) rowsEN else rowsRU
        for ((i, row) in rows.withIndex()) {
            val rowView = makeRow()

            if (i == 2) rowView.addView(makeModKey("⇧") { toggleShift() })

            for (ch in row) {
                val display = if (shiftOn) ch.uppercaseChar().toString() else ch.toString()
                rowView.addView(
                    makeLetterKey(display) {
                        commitChar(display)
                        if (shiftOn) toggleShift()
                    }
                )
            }

            if (i == 2) rowView.addView(makeModKey("⌫") { sendBackspace() })
            area.addView(rowView)
        }

        // Bottom row
        val bottom = makeRow()
        bottom.addView(makeModKey(if (currentLang == Lang.EN) "RU" else "EN") {
            currentLang = if (currentLang == Lang.EN) Lang.RU else Lang.EN
            rebuildKeyboard()
        })
        bottom.addView(makeModKey("123") { /* TODO digits */ })
        bottom.addView(makeMicKey().also { micKey = it })
        bottom.addView(makeLetterKey(" ", weight = 4f) { commitChar(" ") })
        bottom.addView(makeLetterKey(",", weight = 0.9f) { commitChar(",") })
        bottom.addView(makeLetterKey(".", weight = 0.9f) { commitChar(".") })
        bottom.addView(makeModKey("⏎") { sendEnter() })

        area.addView(bottom)
    }

    private fun makeRow(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(48),
        ).apply { topMargin = dp(4) }
        weightSum = 0f // children declare weights
    }

    private fun makeLetterKey(
        label: String,
        weight: Float = 1f,
        onTap: () -> Unit,
    ): TextView = makeKey(label, Pal.KEY_BG, Pal.KEY_FG, weight, fontSize = 18f, onTap)

    private fun makeModKey(
        label: String,
        weight: Float = 1.5f,
        onTap: () -> Unit,
    ): TextView = makeKey(label, Pal.MOD_BG, Pal.KEY_FG_DIM, weight, fontSize = 14f, onTap)

    private fun makeKey(
        label: String,
        bgColor: Int,
        fgColor: Int,
        weight: Float,
        fontSize: Float,
        onTap: () -> Unit,
    ): TextView {
        val tv = TextView(this).apply {
            text = label
            setTextColor(fgColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSize)
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            background = roundedRipple(bgColor, Pal.KEY_BG_PRESS)
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.MATCH_PARENT,
                weight,
            ).apply {
                marginStart = dp(2)
                marginEnd = dp(2)
            }
            setOnClickListener { onTap() }
        }
        return tv
    }

    private fun makeMicKey(): TextView {
        val mic = TextView(this).apply {
            text = "🎤"
            setTextColor(0xFFFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            background = roundedRipple(Pal.MIC_BG, Pal.MIC_BG_REC)
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.MATCH_PARENT,
                1.6f,
            ).apply {
                marginStart = dp(2)
                marginEnd = dp(2)
            }
            setOnClickListener { onMicTap() }
        }
        return mic
    }

    private fun roundedRipple(bg: Int, pressed: Int): RippleDrawable {
        val shape = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(bg)
        }
        return RippleDrawable(ColorStateList.valueOf(pressed), shape, null)
    }

    private fun toggleShift() {
        shiftOn = !shiftOn
        rebuildKeyboard()
    }

    // ─── Input commit ──────────────────────────────────────────────────────

    private fun commitChar(s: CharSequence) {
        currentInputConnection?.commitText(s, 1)
    }

    private fun sendBackspace() {
        val ic = currentInputConnection ?: return
        if (!TextUtils.isEmpty(ic.getSelectedText(0))) {
            ic.commitText("", 1)
        } else {
            ic.deleteSurroundingText(1, 0)
        }
    }

    private fun sendEnter() {
        val ic = currentInputConnection ?: return
        val action = currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION)
        if (action != null && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            ic.performEditorAction(action)
        } else {
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
        }
    }

    // ─── Dictation ─────────────────────────────────────────────────────────

    private fun onMicTap() {
        when (recState) {
            RecState.IDLE -> startRecording()
            RecState.RECORDING -> stopRecording(commit = true)
            RecState.TRANSCRIBING -> { /* ignore */ }
        }
    }

    private fun setStatus(state: RecState) {
        recState = state
        runOnUi {
            statusLabel?.text = when (state) {
                RecState.IDLE -> "wispr-alt"
                RecState.RECORDING -> "● запись… (нажмите 🎤 чтобы остановить)"
                RecState.TRANSCRIBING -> "обрабатываю…"
            }
            micKey?.background = roundedRipple(
                when (state) {
                    RecState.IDLE -> Pal.MIC_BG
                    RecState.RECORDING -> Pal.MIC_BG_REC
                    RecState.TRANSCRIBING -> Pal.MIC_BG_PROC
                },
                Pal.MIC_BG_REC,
            )
        }
    }

    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT

    private fun startRecording() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
            != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            runOnUi {
                statusLabel?.text = "нет доступа к микрофону — откройте wispr-alt и разрешите"
            }
            return
        }

        synchronized(pcmBuffer) { pcmBuffer.reset() }
        lastPartial = ""
        snapshotInFlight = false

        val minBufSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                channelConfig,
                audioFormat,
                minBufSize.coerceAtLeast(4096),
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "AudioRecord init failed", e)
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return
        }

        audioRecord = rec
        rec.startRecording()
        setStatus(RecState.RECORDING)

        // Reader job — fills pcmBuffer continuously
        recordingJob = scope.launch {
            val buf = ByteArray(minBufSize.coerceAtLeast(4096))
            while (isActive && recState == RecState.RECORDING) {
                val read = rec.read(buf, 0, buf.size)
                if (read > 0) {
                    synchronized(pcmBuffer) { pcmBuffer.write(buf, 0, read) }
                }
            }
        }

        // Snapshot job — every 2s POST partial → setComposingText
        snapshotJob = scope.launch {
            while (isActive && recState == RecState.RECORDING) {
                delay(2_000)
                if (recState != RecState.RECORDING) break
                if (snapshotInFlight) continue
                snapshotInFlight = true
                try {
                    val snap = synchronized(pcmBuffer) { pcmBuffer.toByteArray() }
                    if (snap.size < 4_000) continue
                    val wav = pcmToWav(snap, sampleRate)
                    val partial = transcribe(wav, postprocess = false) ?: continue
                    if (recState == RecState.RECORDING && partial.isNotBlank()) {
                        lastPartial = partial
                        runOnUi {
                            currentInputConnection?.setComposingText(partial, 1)
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "snapshot failed", e)
                } finally {
                    snapshotInFlight = false
                }
            }
        }
    }

    private fun stopRecording(commit: Boolean) {
        val rec = audioRecord ?: return
        try { rec.stop(); rec.release() } catch (_: Exception) {}
        audioRecord = null
        recordingJob?.cancel()
        snapshotJob?.cancel()

        if (!commit) {
            // discard composing partial
            currentInputConnection?.finishComposingText()
            setStatus(RecState.IDLE)
            return
        }

        setStatus(RecState.TRANSCRIBING)

        val pcm = synchronized(pcmBuffer) { pcmBuffer.toByteArray() }
        if (pcm.size < 4_000) {
            currentInputConnection?.finishComposingText()
            setStatus(RecState.IDLE)
            return
        }

        scope.launch {
            val wav = pcmToWav(pcm, sampleRate)
            val clean = try {
                transcribe(wav, postprocess = true)
            } catch (e: Exception) {
                Log.e(TAG, "final transcribe failed", e)
                null
            }
            withContext(Dispatchers.Main) {
                val ic = currentInputConnection
                if (!clean.isNullOrBlank() && ic != null) {
                    // Replace the composing partial with the cleaned final text.
                    ic.setComposingText(clean, 1)
                    ic.finishComposingText()
                } else {
                    // Either failure or empty result — finalize whatever's
                    // already composed (the last partial).
                    ic?.finishComposingText()
                }
            }
            setStatus(RecState.IDLE)
        }
    }

    // ─── PCM → WAV ─────────────────────────────────────────────────────────

    private fun pcmToWav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val out = ByteArrayOutputStream(pcm.size + 44)
        val totalDataLen = pcm.size + 36
        val byteRate = sampleRate * 2

        out.write("RIFF".toByteArray())
        out.write(intLE(totalDataLen))
        out.write("WAVE".toByteArray())

        out.write("fmt ".toByteArray())
        out.write(intLE(16))
        out.write(shortLE(1))           // PCM
        out.write(shortLE(1))           // 1 channel
        out.write(intLE(sampleRate))
        out.write(intLE(byteRate))
        out.write(shortLE(2))           // block align
        out.write(shortLE(16))          // bits per sample

        out.write("data".toByteArray())
        out.write(intLE(pcm.size))
        out.write(pcm)
        return out.toByteArray()
    }

    private fun intLE(v: Int) = byteArrayOf(
        (v and 0xff).toByte(),
        ((v shr 8) and 0xff).toByte(),
        ((v shr 16) and 0xff).toByte(),
        ((v shr 24) and 0xff).toByte(),
    )
    private fun shortLE(v: Int) = byteArrayOf(
        (v and 0xff).toByte(),
        ((v shr 8) and 0xff).toByte(),
    )

    // ─── HTTP ──────────────────────────────────────────────────────────────

    private fun transcribe(wav: ByteArray, postprocess: Boolean): String? {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "audio",
                "recording.wav",
                wav.toRequestBody("audio/wav".toMediaType()),
            )
            .addFormDataPart("postprocess", postprocess.toString())
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
            } else {
                json.optString("raw")
            }
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    private fun runOnUi(block: () -> Unit) {
        rootView?.post(block)
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt().coerceAtLeast(1)

    companion object {
        private const val TAG = "KeyboardService"
    }

    @Suppress("unused")
    private fun unused(vp: ViewGroup) {}
}
