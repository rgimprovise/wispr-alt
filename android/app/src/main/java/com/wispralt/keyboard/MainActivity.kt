package com.wispralt.keyboard

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Single-activity router that decides between the onboarding carousel
 * and the home screen based on `OnboardingState.isCompleted()` and the
 * runtime permission state.
 *
 * Onboarding flow (mimics Wispr Flow's pattern, simplified):
 *   1. Welcome — value prop + "Get started"
 *   2. How it works — bubble explanation
 *   3. Microphone — pre-permission + system dialog
 *   4. Display over apps — pre-permission + system settings deep-link
 *   5. Accessibility — disclosure (long text, Google Play compliance) +
 *      system settings deep-link
 *   6. Notifications (Android 13+) — runtime permission
 *   7. All set — final celebration
 *
 * Home screen (after completion or re-launch with onboarding done):
 *   - Service toggle (start/stop foreground service)
 *   - Permission gate banners (re-prompt for any missing permission)
 *   - Quick how-to tips
 *
 * Implementation: programmatic Views (no XML) for fast iteration. Once
 * the Belovik design assets land, swap the styling tokens.
 */
class MainActivity : AppCompatActivity() {

    private enum class Step(val index: Int, val total: Int) {
        WELCOME(0, 6),
        HOW_IT_WORKS(1, 6),
        MIC(2, 6),
        OVERLAY_PERM(3, 6),
        ACCESSIBILITY(4, 6),
        NOTIFICATIONS(5, 6),
        DONE(6, 6),
    }

    private var currentStep = Step.WELCOME

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildShellLayout())
        renderForState()
    }

    override fun onResume() {
        super.onResume()
        // Refresh on every resume so that returning from system settings
        // updates the visible state immediately.
        renderForState()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        renderForState()
    }

    // ─── Shell ─────────────────────────────────────────────────────────────

    private fun buildShellLayout(): View {
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0E0E10.toInt())
        }
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
            ).apply { weight = 1f }
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(24))
        }
        scroll.addView(content)
        outer.addView(scroll)
        return outer
    }

    private fun container(): LinearLayout {
        val scroll = (findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as LinearLayout)
            .getChildAt(0) as ScrollView
        return scroll.getChildAt(0) as LinearLayout
    }

    // ─── Render router ─────────────────────────────────────────────────────

    private fun renderForState() {
        if (OnboardingState.isCompleted(this)) {
            renderHome()
        } else {
            renderOnboarding(currentStep)
        }
    }

    // ─── Onboarding screens ────────────────────────────────────────────────

    private fun renderOnboarding(step: Step) {
        currentStep = step
        val c = container()
        c.removeAllViews()

        c.addView(buildProgressBar(step))
        c.addView(spacer(dp(24)))

        when (step) {
            Step.WELCOME -> renderWelcome(c)
            Step.HOW_IT_WORKS -> renderHowItWorks(c)
            Step.MIC -> renderMicStep(c)
            Step.OVERLAY_PERM -> renderOverlayStep(c)
            Step.ACCESSIBILITY -> renderAccessibilityStep(c)
            Step.NOTIFICATIONS -> renderNotificationsStep(c)
            Step.DONE -> renderDone(c)
        }
    }

    private fun buildProgressBar(step: Step): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        for (i in 0 until step.total) {
            val seg = View(this).apply {
                background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    cornerRadius = dp(2).toFloat()
                    setColor(if (i < step.index) 0xFFEF4444.toInt() else 0xFF2D2F31.toInt())
                }
                layoutParams = LinearLayout.LayoutParams(0, dp(4), 1f).apply {
                    if (i > 0) marginStart = dp(4)
                }
            }
            row.addView(seg)
        }
        return row
    }

    private fun renderWelcome(c: LinearLayout) {
        c.addView(headline("wispr-alt"))
        c.addView(spacer(dp(8)))
        c.addView(subtext("Голосовой интерфейс для работы с текстом"))
        c.addView(spacer(dp(48)))
        c.addView(card(
            title = "Говорите свободно — получайте чистый текст",
            body = "Голосовой ввод в любое приложение через плавающую кнопку. Записывайте мысль голосом, текст автоматически попадает в активное поле.",
        ))
        c.addView(spacer(dp(40)))
        c.addView(primaryButton("Начать") { advance() })
    }

    private fun renderHowItWorks(c: LinearLayout) {
        c.addView(headline("Как это работает"))
        c.addView(spacer(dp(20)))
        c.addView(stepItem(1, "Тапните в любое текстовое поле"))
        c.addView(spacer(dp(12)))
        c.addView(stepItem(2, "Появится круглая кнопка-микрофон"))
        c.addView(spacer(dp(12)))
        c.addView(stepItem(3, "Тап или удержание — запись"))
        c.addView(spacer(dp(12)))
        c.addView(stepItem(4, "Текст вставится в поле автоматически"))
        c.addView(spacer(dp(40)))
        c.addView(primaryButton("Дальше") { advance() })
    }

    private fun renderMicStep(c: LinearLayout) {
        c.addView(headline("Доступ к микрофону"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("Нужен чтобы записывать вашу речь и превращать её в текст. Аудио шифруется и не сохраняется."))
        c.addView(spacer(dp(40)))
        if (hasMic()) {
            c.addView(grantedRow("Микрофон разрешён"))
            c.addView(spacer(dp(24)))
            c.addView(primaryButton("Дальше") { advance() })
        } else {
            c.addView(primaryButton("Разрешить микрофон") { requestMicPermission() })
        }
    }

    private fun renderOverlayStep(c: LinearLayout) {
        c.addView(headline("Показ поверх приложений"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("Без этого разрешения кнопка-микрофон не появится поверх Telegram, заметок и других приложений. Это ключевая функция wispr-alt."))
        c.addView(spacer(dp(40)))
        if (hasOverlay()) {
            c.addView(grantedRow("Разрешено"))
            c.addView(spacer(dp(24)))
            c.addView(primaryButton("Дальше") { advance() })
        } else {
            c.addView(primaryButton("Открыть настройки") { openOverlaySettings() })
        }
    }

    private fun renderAccessibilityStep(c: LinearLayout) {
        c.addView(headline("Спец. возможности"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("wispr-alt использует API специальных возможностей чтобы вставлять распознанный текст в активное поле."))
        c.addView(spacer(dp(20)))

        // Disclosure block (verbose — required for Google Play compliance)
        c.addView(card(
            title = "Что мы делаем с этим разрешением",
            body = """
                wispr-alt использует доступ к содержимому экрана, чтобы вставить распознанный голос в текущее текстовое поле — точно туда, где вы поставили курсор.

                Что мы НЕ делаем:
                • Не читаем содержимое полей паролей и кредитных карт
                • Не сохраняем содержимое экрана
                • Не отправляем никаких данных кроме самой аудио-записи на наш сервер транскрипции

                Аудио передаётся по HTTPS на сервер транскрипции, обрабатывается и сразу удаляется. Текст возвращается на устройство и вставляется локально.
            """.trimIndent(),
        ))

        c.addView(spacer(dp(20)))
        c.addView(card(
            title = "После открытия настроек",
            body = """
                1. Найдите раздел «Скачанные приложения»
                2. Тапните по wispr-alt
                3. Включите главный тумблер
                4. Не включайте «Быстрый запуск функции» (shortcut) — он не нужен
                5. Вернитесь в приложение
            """.trimIndent(),
        ))
        c.addView(spacer(dp(40)))
        if (hasA11y()) {
            c.addView(grantedRow("Спец. возможности включены"))
            c.addView(spacer(dp(24)))
            c.addView(primaryButton("Дальше") { advance() })
        } else {
            c.addView(primaryButton("Открыть настройки") { openAccessibilitySettings() })
            c.addView(spacer(dp(8)))
            c.addView(secondaryButton("Пропустить пока") { advance() })
        }
    }

    private fun renderNotificationsStep(c: LinearLayout) {
        c.addView(headline("Уведомления"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("Уведомление в шторке показывает что wispr-alt активен и даёт быстрый доступ к диктовке. Без него тоже всё работает."))
        c.addView(spacer(dp(40)))
        if (hasNotifications()) {
            c.addView(grantedRow("Уведомления разрешены"))
            c.addView(spacer(dp(24)))
            c.addView(primaryButton("Дальше") { advance() })
        } else if (Build.VERSION.SDK_INT >= 33) {
            c.addView(primaryButton("Разрешить уведомления") { requestNotificationPermission() })
            c.addView(spacer(dp(8)))
            c.addView(secondaryButton("Пропустить") { advance() })
        } else {
            // Pre-Android 13 — auto-granted
            advance()
        }
    }

    private fun renderDone(c: LinearLayout) {
        c.addView(headline("Готово"))
        c.addView(spacer(dp(20)))
        c.addView(subtext("Откройте Telegram, заметки или любое приложение с текстовым полем. Тапните в поле — появится кнопка-микрофон. Удержание = быстрая диктовка."))
        c.addView(spacer(dp(40)))
        c.addView(primaryButton("Включить wispr-alt") {
            OnboardingState.markCompleted(this)
            if (allRequiredPermissionsGranted()) {
                WisprService.start(this)
            }
            renderForState()
        })
    }

    private fun advance() {
        val next = Step.entries.firstOrNull { it.index == currentStep.index + 1 }
        if (next != null) {
            renderOnboarding(next)
        } else {
            OnboardingState.markCompleted(this)
            renderForState()
        }
    }

    // ─── Home screen ───────────────────────────────────────────────────────

    private fun renderHome() {
        val c = container()
        c.removeAllViews()

        c.addView(headline("wispr-alt"))
        c.addView(spacer(dp(4)))
        c.addView(subtext("Голосовой интерфейс для работы с текстом"))
        c.addView(spacer(dp(24)))

        // Service toggle card
        val running = WisprService.instance != null
        c.addView(serviceToggleCard(running))
        c.addView(spacer(dp(20)))

        // Gate banners — one per missing permission
        if (!hasMic()) c.addView(gateBanner(
            "Микрофон не разрешён",
            "Без доступа к микрофону приложение не сможет записывать голос.",
            "Разрешить",
        ) { requestMicPermission() })
        if (!hasOverlay()) c.addView(gateBanner(
            "Показ поверх приложений выключен",
            "Кнопка-микрофон не появится в других приложениях.",
            "Открыть настройки",
        ) { openOverlaySettings() })
        if (!hasA11y()) c.addView(gateBanner(
            "Спец. возможности выключены",
            "Без них wispr-alt не сможет вставить распознанный текст в активное поле.",
            "Открыть настройки",
        ) { openAccessibilitySettings() })

        // Quick tips
        c.addView(spacer(dp(16)))
        c.addView(card(
            title = "Как использовать",
            body = """
                1. Откройте любое приложение с текстовым полем
                2. Тапните в поле — появится круглая кнопка-микрофон
                3. Тап = развернуть панель, удержание ≥0.4 сек = быстрая запись
                4. Отпускание (или ✓) = текст вставится в поле

                Кнопку можно перетаскивать в удобную позицию пальцем.
            """.trimIndent(),
        ))

        c.addView(spacer(dp(24)))
        c.addView(secondaryButton("Пройти онбординг заново") {
            OnboardingState.reset(this)
            currentStep = Step.WELCOME
            renderForState()
        })
    }

    private fun serviceToggleCard(running: Boolean): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(16).toFloat()
                setColor(0xFF1D1D22.toInt())
                setStroke(dp(1), 0xFF2D2F31.toInt())
            }
        }
        card.addView(TextView(this).apply {
            text = if (running) "Сервис активен" else "Сервис не запущен"
            setTextColor(if (running) 0xFF10B981.toInt() else 0xFFE5E7EB.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(8)))
        card.addView(TextView(this).apply {
            text = if (running) "wispr-alt работает в фоне. Тапните в любое текстовое поле — появится кнопка."
            else "Запустите фоновый сервис чтобы кнопка появлялась автоматически."
            setTextColor(0xFFA8A8A5.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        })
        card.addView(spacer(dp(16)))
        card.addView(if (running) {
            secondaryButton("Остановить") {
                WisprService.stop(this)
                renderForState()
            }
        } else {
            primaryButton("Запустить") {
                if (allRequiredPermissionsGranted()) {
                    WisprService.start(this)
                    renderForState()
                } else {
                    renderForState()
                }
            }
        })
        return card
    }

    private fun gateBanner(
        title: String,
        body: String,
        cta: String,
        action: () -> Unit,
    ): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(12).toFloat()
                setColor(0xFF2D1B1F.toInt())
                setStroke(dp(1), 0xFFEF4444.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(12) }
        }
        card.addView(TextView(this).apply {
            text = "⚠  $title"
            setTextColor(0xFFFCA5A5.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(4)))
        card.addView(TextView(this).apply {
            text = body
            setTextColor(0xFFD4A8AC.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        })
        card.addView(spacer(dp(10)))
        val btn = Button(this).apply {
            text = cta
            isAllCaps = false
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFFEF4444.toInt())
            setOnClickListener { action() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(40),
            )
        }
        card.addView(btn)
        return card
    }

    // ─── Reusable view-builders ────────────────────────────────────────────

    private fun headline(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(0xFFF5F5F4.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
        typeface = android.graphics.Typeface.DEFAULT_BOLD
    }

    private fun subtext(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(0xFFA8A8A5.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setLineSpacing(0f, 1.3f)
    }

    private fun stepItem(num: Int, text: String): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val numView = TextView(this).apply {
            this.text = num.toString()
            setTextColor(0xFFFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(0xFFEF4444.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(dp(28), dp(28)).apply {
                marginEnd = dp(12)
            }
        }
        row.addView(numView)
        row.addView(TextView(this).apply {
            this.text = text
            setTextColor(0xFFE5E7EB.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        })
        return row
    }

    private fun card(title: String, body: String): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(16).toFloat()
                setColor(0xFF1D1D22.toInt())
                setStroke(dp(1), 0xFF2D2F31.toInt())
            }
        }
        card.addView(TextView(this).apply {
            this.text = title
            setTextColor(0xFFF5F5F4.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(8)))
        card.addView(TextView(this).apply {
            this.text = body
            setTextColor(0xFFA8A8A5.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setLineSpacing(0f, 1.4f)
        })
        return card
    }

    private fun grantedRow(text: String): View {
        return TextView(this).apply {
            this.text = "✓  $text"
            setTextColor(0xFF10B981.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
    }

    private fun primaryButton(text: String, action: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            isAllCaps = false
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFFEF4444.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setOnClickListener { action() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(52),
            )
        }
    }

    private fun secondaryButton(text: String, action: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            isAllCaps = false
            setTextColor(0xFFA8A8A5.toInt())
            setBackgroundColor(0x00000000)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setOnClickListener { action() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(44),
            )
        }
    }

    private fun spacer(height: Int): View = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            height,
        )
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt().coerceAtLeast(1)

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
        startActivity(
            Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName"),
            )
        )
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

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
        hasMic() && hasOverlay() && hasA11y()

    companion object {
        private const val REQ_MIC = 1001
        private const val REQ_NOTIF = 1002
    }
}
