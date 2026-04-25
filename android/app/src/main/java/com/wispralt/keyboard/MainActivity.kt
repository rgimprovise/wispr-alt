package com.wispralt.keyboard

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Onboarding + control panel.
 *
 * Four permissions/setup steps for the overlay-driven UX:
 *   1. Microphone (runtime)
 *   2. Display over other apps (settings deep link)
 *   3. Accessibility service (settings deep link)
 *   4. Notifications (Android 13+, runtime)
 *
 * Once all are granted, an "Включить wispr-alt" button starts the foreground
 * service. Tile / notification action then trigger dictation any time.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var enableButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 64, 48, 48)
        }

        TextView(this).apply {
            text = "wispr-alt"
            textSize = 28f
            setPadding(0, 0, 0, 8)
        }.also(root::addView)

        TextView(this).apply {
            text = "Голосовой ввод поверх любого приложения"
            textSize = 14f
            setPadding(0, 0, 0, 24)
        }.also(root::addView)

        statusText = TextView(this).apply {
            text = ""
            textSize = 13f
            setPadding(0, 0, 0, 16)
        }
        root.addView(statusText)

        Button(this).apply {
            text = "1. Разрешить микрофон"
            setOnClickListener { requestMicPermission() }
        }.also(root::addView)

        Button(this).apply {
            text = "2. Показ поверх других приложений"
            setOnClickListener { openOverlaySettings() }
        }.also(root::addView)

        Button(this).apply {
            text = "3. Включить специальные возможности"
            setOnClickListener { openAccessibilitySettings() }
        }.also(root::addView)

        if (Build.VERSION.SDK_INT >= 33) {
            Button(this).apply {
                text = "4. Разрешить уведомления"
                setOnClickListener { requestNotificationPermission() }
            }.also(root::addView)
        }

        enableButton = Button(this).apply {
            text = "Включить wispr-alt"
            setOnClickListener { toggleService() }
            setPadding(0, 24, 0, 0)
        }
        root.addView(enableButton)

        TextView(this).apply {
            text = """
                Использование:

                • Тапните «Включить wispr-alt» — появится постоянное уведомление
                • Откройте любое приложение (Telegram, Заметки, браузер) и поставьте курсор в текстовое поле
                • Активируйте wispr-alt одним из способов:
                   – Свайп от верха экрана и тап по плитке wispr-alt в Quick Settings
                   – Тап «Диктовка» в постоянном уведомлении
                • Сверху экрана выплывет pill — говорите фразу
                • Тап по pill чтобы закончить — текст вставится в активное поле

                Совет: добавьте плитку wispr-alt в Quick Settings панель
                (свайп от верха → нажмите ✏️ Edit → перетащите wispr-alt в активные плитки).
            """.trimIndent()
            textSize = 12f
            setPadding(0, 24, 0, 0)
        }.also(root::addView)

        setContentView(root)
        refreshStatus()
    }

    override fun onResume() { super.onResume(); refreshStatus() }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshStatus()
    }

    // ─── Permission helpers ────────────────────────────────────────────────

    private fun requestMicPermission() {
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.RECORD_AUDIO),
            REQ_MIC,
        )
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQ_NOTIF,
            )
        }
    }

    private fun openOverlaySettings() {
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:$packageName"),
        )
        startActivity(intent)
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun toggleService() {
        if (WisprService.instance != null) {
            WisprService.stop(this)
            enableButton.text = "Включить wispr-alt"
        } else {
            if (!allRequiredPermissionsGranted()) {
                statusText.text = "сначала выдайте все разрешения выше"
                return
            }
            WisprService.start(this)
            enableButton.text = "Остановить wispr-alt"
        }
    }

    // ─── Status ────────────────────────────────────────────────────────────

    private fun hasMic() = ContextCompat.checkSelfPermission(
        this, Manifest.permission.RECORD_AUDIO
    ) == PackageManager.PERMISSION_GRANTED

    private fun hasOverlay() = Settings.canDrawOverlays(this)

    private fun hasA11y(): Boolean {
        val flat = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        val needle = "$packageName/${WisprAccessibilityService::class.java.name}"
        return flat.split(':').any { it.equals(needle, ignoreCase = true) }
    }

    private fun hasNotifications(): Boolean {
        if (Build.VERSION.SDK_INT < 33) return true
        return ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun allRequiredPermissionsGranted(): Boolean =
        hasMic() && hasOverlay() && hasA11y() && hasNotifications()

    private fun refreshStatus() {
        statusText.text = buildString {
            appendLine("● микрофон: ${if (hasMic()) "✓" else "✗"}")
            appendLine("● показ поверх других: ${if (hasOverlay()) "✓" else "✗"}")
            appendLine("● спец. возможности: ${if (hasA11y()) "✓" else "✗"}")
            if (Build.VERSION.SDK_INT >= 33) {
                appendLine("● уведомления: ${if (hasNotifications()) "✓" else "✗"}")
            }
            appendLine()
            append("Сервис: ${if (WisprService.instance != null) "запущен ✓" else "остановлен"}")
        }
        enableButton.text = if (WisprService.instance != null) "Остановить wispr-alt" else "Включить wispr-alt"
    }

    companion object {
        private const val REQ_MIC = 1001
        private const val REQ_NOTIF = 1002
    }
}
