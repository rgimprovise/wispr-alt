package com.wispralt.keyboard

import android.inputmethodservice.InputMethodService
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * wispr-alt soft keyboard IME with a dictation button.
 *
 * Keyboard layout: classic QWERTY (English) or ЙЦУКЕН (Russian), 4 rows.
 * Bottom row includes a prominent microphone button that streams audio
 * to our backend and commits the transcribed text to the current input.
 */
class KeyboardService : InputMethodService() {

    private enum class Lang { EN, RU }
    private enum class RecState { IDLE, RECORDING, TRANSCRIBING }

    private var currentLang = Lang.EN
    private var shiftOn = false
    private var recState = RecState.IDLE

    // Audio
    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private val pcmBuffer = ByteArrayOutputStream()

    // UI refs
    private var keyboardView: LinearLayout? = null
    private var micButton: Button? = null
    private var statusLabel: TextView? = null

    private val scope = CoroutineScope(Dispatchers.IO)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    override fun onCreateInputView(): View {
        val ctx = this
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0E0E10.toInt())
            setPadding(12, 12, 12, 16)
        }

        // Status strip
        statusLabel = TextView(ctx).apply {
            text = "wispr-alt"
            setTextColor(0xFF8A877E.toInt())
            textSize = 11f
            setPadding(6, 4, 6, 8)
        }
        root.addView(statusLabel)

        val keys = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
        }
        root.addView(keys)
        keyboardView = keys
        rebuildKeyboard()

        return root
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        // Keep state; user continues wherever they left off.
    }

    override fun onFinishInput() {
        super.onFinishInput()
        if (recState != RecState.IDLE) stopRecording(commit = false)
    }

    // ─── Keyboard rendering ────────────────────────────────────────────────

    private val rowsEn = listOf(
        "qwertyuiop",
        "asdfghjkl",
        "zxcvbnm"
    )
    private val rowsRu = listOf(
        "йцукенгшщзх",
        "фывапролджэ",
        "ячсмитьбю"
    )

    private fun rebuildKeyboard() {
        val keys = keyboardView ?: return
        keys.removeAllViews()

        val rows = if (currentLang == Lang.EN) rowsEn else rowsRu
        for ((i, row) in rows.withIndex()) {
            val rowLayout = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    0,
                    1f
                )
            }

            // Row 3 (EN) / 3 (RU) gets a Shift key on the left.
            if (i == 2) {
                rowLayout.addView(
                    makeKey("⇧", weight = 1.5f) { shiftOn = !shiftOn; updateShiftVisual() }
                )
            }

            for (ch in row) {
                val display = if (shiftOn) ch.uppercaseChar() else ch
                rowLayout.addView(
                    makeKey(display.toString()) {
                        commitText(display.toString())
                        if (shiftOn) {
                            shiftOn = false
                            updateShiftVisual()
                        }
                    }
                )
            }

            // Row 3 gets Backspace on the right.
            if (i == 2) {
                rowLayout.addView(
                    makeKey("⌫", weight = 1.5f) { sendBackspace() }
                )
            }

            keys.addView(rowLayout)
        }

        // Bottom bar: 123 | globe | mic | space | enter
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1.2f
            )
        }
        bottom.addView(
            makeKey(if (currentLang == Lang.EN) "RU" else "EN", weight = 1.2f) {
                currentLang = if (currentLang == Lang.EN) Lang.RU else Lang.EN
                rebuildKeyboard()
            }
        )
        bottom.addView(
            makeMicKey().also { micButton = it }
        )
        bottom.addView(makeKey(" ", weight = 4f) { commitText(" ") })
        bottom.addView(makeKey(",", weight = 0.9f) { commitText(",") })
        bottom.addView(makeKey(".", weight = 0.9f) { commitText(".") })
        bottom.addView(makeKey("⏎", weight = 1.2f) { sendEnter() })

        keyboardView?.addView(bottom)
    }

    private fun makeKey(
        label: String,
        weight: Float = 1f,
        onTap: () -> Unit
    ): Button {
        return Button(this).apply {
            text = label
            setTextColor(0xFFF5F5F4.toInt())
            setBackgroundColor(0xFF1D1D22.toInt())
            textSize = 16f
            setPadding(0, 0, 0, 0)
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.MATCH_PARENT,
                weight
            ).apply { setMargins(3, 3, 3, 3) }
            setOnClickListener { onTap() }
        }
    }

    private fun makeMicKey(): Button {
        return Button(this).apply {
            text = "🎤"
            setTextColor(0xFFF5F5F4.toInt())
            setBackgroundColor(0xFFEF4444.toInt())
            textSize = 18f
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.MATCH_PARENT,
                1.6f
            ).apply { setMargins(3, 3, 3, 3) }
            setOnClickListener { onMicTap() }
        }
    }

    private fun updateShiftVisual() {
        rebuildKeyboard() // cheap — whole keyboard rerender
    }

    // ─── Input commits ─────────────────────────────────────────────────────

    private fun commitText(text: CharSequence) {
        currentInputConnection?.commitText(text, 1)
    }

    private fun sendBackspace() {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        if (!TextUtils.isEmpty(selected)) {
            ic.commitText("", 1)
        } else {
            ic.deleteSurroundingText(1, 0)
        }
    }

    private fun sendEnter() {
        val ic = currentInputConnection ?: return
        val editorInfo = currentInputEditorInfo
        val action = editorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION)
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
            RecState.TRANSCRIBING -> {
                // ignore
            }
        }
    }

    private fun setStatus(state: RecState) {
        recState = state
        mainHandler.post {
            statusLabel?.text = when (state) {
                RecState.IDLE -> "wispr-alt"
                RecState.RECORDING -> "● recording…"
                RecState.TRANSCRIBING -> "transcribing…"
            }
            micButton?.setBackgroundColor(
                when (state) {
                    RecState.IDLE -> 0xFFEF4444.toInt()
                    RecState.RECORDING -> 0xFFDC2626.toInt()
                    RecState.TRANSCRIBING -> 0xFFF59E0B.toInt()
                }
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
            // Prompt user to open app and grant permission.
            mainHandler.post {
                statusLabel?.text = "no mic permission — open wispr-alt app"
            }
            return
        }

        pcmBuffer.reset()
        val minBufSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                channelConfig,
                audioFormat,
                minBufSize.coerceAtLeast(4096)
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "AudioRecord creation failed", e)
            return
        }

        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord not initialized")
            rec.release()
            return
        }

        audioRecord = rec
        rec.startRecording()
        setStatus(RecState.RECORDING)

        recordingJob = scope.launch {
            val buf = ByteArray(minBufSize.coerceAtLeast(4096))
            while (recState == RecState.RECORDING) {
                val read = rec.read(buf, 0, buf.size)
                if (read > 0) pcmBuffer.write(buf, 0, read)
            }
        }
    }

    private fun stopRecording(commit: Boolean) {
        val rec = audioRecord ?: return
        try {
            rec.stop()
            rec.release()
        } catch (_: Exception) {}
        audioRecord = null
        recordingJob?.cancel()

        if (!commit) {
            setStatus(RecState.IDLE)
            return
        }

        setStatus(RecState.TRANSCRIBING)

        val pcm = pcmBuffer.toByteArray()
        if (pcm.size < 1024) {
            setStatus(RecState.IDLE)
            return
        }

        scope.launch {
            val wav = pcmToWav(pcm, sampleRate)
            val text = try {
                transcribe(wav)
            } catch (e: Exception) {
                Log.e(TAG, "transcribe failed", e)
                null
            }
            if (!text.isNullOrBlank()) {
                withContext(Dispatchers.Main) { commitText(text) }
            }
            setStatus(RecState.IDLE)
        }
    }

    private fun pcmToWav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val totalDataLen = pcm.size + 36
        val byteRate = sampleRate * 2 // 16-bit mono
        // RIFF header
        out.write("RIFF".toByteArray())
        out.write(intLE(totalDataLen))
        out.write("WAVE".toByteArray())
        // fmt chunk
        out.write("fmt ".toByteArray())
        out.write(intLE(16))
        out.write(shortLE(1))       // PCM
        out.write(shortLE(1))       // channels = 1
        out.write(intLE(sampleRate))
        out.write(intLE(byteRate))
        out.write(shortLE(2))       // block align
        out.write(shortLE(16))      // bits per sample
        // data chunk
        out.write("data".toByteArray())
        out.write(intLE(pcm.size))
        out.write(pcm)
        return out.toByteArray()
    }

    private fun intLE(v: Int): ByteArray = byteArrayOf(
        (v and 0xff).toByte(),
        ((v shr 8) and 0xff).toByte(),
        ((v shr 16) and 0xff).toByte(),
        ((v shr 24) and 0xff).toByte()
    )

    private fun shortLE(v: Int): ByteArray = byteArrayOf(
        (v and 0xff).toByte(),
        ((v shr 8) and 0xff).toByte()
    )

    private fun transcribe(wav: ByteArray): String? {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "audio",
                "recording.wav",
                wav.toRequestBody("audio/wav".toMediaType())
            )
            .addFormDataPart("postprocess", "true")
            .build()

        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/transcribe")
            .post(body)
            .build()

        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return null
            val text = res.body?.string() ?: return null
            val json = JSONObject(text)
            return json.optString("clean").ifBlank { json.optString("raw") }
        }
    }

    companion object {
        private const val TAG = "KeyboardService"
    }
}
