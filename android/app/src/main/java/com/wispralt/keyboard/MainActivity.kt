package com.wispralt.keyboard

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Simple onboarding screen — instructs the user to (1) grant microphone
 * permission, (2) enable wispr-alt as a system keyboard in Android
 * settings, (3) select it as the active input method.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var micButton: Button
    private lateinit var enableButton: Button
    private lateinit var pickButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 64, 48, 48)
        }

        val title = TextView(this).apply {
            text = "wispr-alt"
            textSize = 28f
            setPadding(0, 0, 0, 8)
        }
        root.addView(title)

        val subtitle = TextView(this).apply {
            text = "Клавиатура с голосовым вводом"
            textSize = 14f
            setPadding(0, 0, 0, 32)
        }
        root.addView(subtitle)

        statusText = TextView(this).apply {
            text = ""
            textSize = 13f
            setPadding(0, 0, 0, 24)
        }
        root.addView(statusText)

        micButton = Button(this).apply {
            text = "1. Разрешить микрофон"
            setOnClickListener { requestMicPermission() }
        }
        root.addView(micButton)

        enableButton = Button(this).apply {
            text = "2. Включить клавиатуру в настройках"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
            }
        }
        root.addView(enableButton)

        pickButton = Button(this).apply {
            text = "3. Выбрать wispr-alt как активную"
            setOnClickListener {
                val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
                imm.showInputMethodPicker()
            }
        }
        root.addView(pickButton)

        val hint = TextView(this).apply {
            text = "После установки — откройте любое приложение с текстовым полем и " +
                "смените клавиатуру через значок в правом нижнем углу.\n\n" +
                "На клавиатуре wispr-alt красная кнопка 🎤 — одно нажатие для старта " +
                "записи, ещё раз для остановки. Текст автоматически вставится."
            textSize = 12f
            setPadding(0, 32, 0, 0)
        }
        root.addView(hint)

        setContentView(root)
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshStatus()
    }

    private fun requestMicPermission() {
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.RECORD_AUDIO),
            REQ_MIC
        )
    }

    private fun refreshStatus() {
        val hasMic = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        val ourId = "$packageName/.KeyboardService"
        val enabled = imm.enabledInputMethodList.any {
            it.id == ourId
        }

        val ready = hasMic && enabled
        statusText.text = buildString {
            appendLine("● микрофон: ${if (hasMic) "✓" else "✗"}")
            appendLine("● клавиатура включена: ${if (enabled) "✓" else "✗"}")
            if (ready) append("\nГотово к использованию.")
        }
    }

    companion object {
        private const val REQ_MIC = 1001
    }
}
