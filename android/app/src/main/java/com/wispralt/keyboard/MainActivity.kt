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
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Single-activity router that decides between the onboarding carousel
 * and the home screen based on `OnboardingState.isCompleted()` and the
 * runtime permission state. All visuals follow the Belovik design system:
 * light-first paper background, soft-radius cards, graphite accents.
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

    private fun col(id: Int): Int = ContextCompat.getColor(this, id)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Auth gate: bounce to LoginActivity until we have a JWT. Re-checked
        // in onResume() so that signing out (or a 401 elsewhere clearing
        // the store) immediately routes back to login.
        if (!AuthStore.isSignedIn(this)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        setContentView(buildShellLayout())
        renderForState()
    }

    override fun onResume() {
        super.onResume()
        if (!AuthStore.isSignedIn(this)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
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
            setBackgroundColor(col(R.color.bg_base))
        }
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
            ).apply { weight = 1f }
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(56), dp(28), dp(32))
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
        c.addView(spacer(dp(28)))

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
                    setColor(if (i < step.index) col(R.color.graphite) else col(R.color.surface_sunk))
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
        c.addView(displayHeadline("Беловик"))
        c.addView(spacer(dp(8)))
        c.addView(subtext("Голосовой интерфейс для работы с текстом"))
        c.addView(spacer(dp(40)))
        c.addView(card(
            title = "Говорите свободно — получайте чистый текст",
            body = "Голосовой ввод в любое приложение через плавающую кнопку. Записывайте мысль голосом, текст автоматически попадает в активное поле.",
        ))
        c.addView(spacer(dp(32)))
        c.addView(primaryButton("Начать") { advance() })
    }

    private fun renderHowItWorks(c: LinearLayout) {
        c.addView(displayHeadline("Как это работает"))
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
        c.addView(displayHeadline("Доступ к микрофону"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("Нужен чтобы записывать вашу речь и превращать её в текст. Аудио шифруется и не сохраняется."))
        c.addView(spacer(dp(32)))
        if (hasMic()) {
            c.addView(grantedRow("Микрофон разрешён"))
            c.addView(spacer(dp(20)))
            c.addView(primaryButton("Дальше") { advance() })
        } else {
            c.addView(primaryButton("Разрешить микрофон") { requestMicPermission() })
        }
    }

    private fun renderOverlayStep(c: LinearLayout) {
        c.addView(displayHeadline("Показ поверх приложений"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("Без этого разрешения кнопка-микрофон не появится поверх Telegram, заметок и других приложений. Это ключевая функция."))
        c.addView(spacer(dp(32)))
        if (hasOverlay()) {
            c.addView(grantedRow("Разрешено"))
            c.addView(spacer(dp(20)))
            c.addView(primaryButton("Дальше") { advance() })
        } else {
            c.addView(primaryButton("Открыть настройки") { openOverlaySettings() })
        }
    }

    private fun renderAccessibilityStep(c: LinearLayout) {
        c.addView(displayHeadline("Спец. возможности"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("Беловик использует API специальных возможностей чтобы вставлять распознанный текст в активное поле."))
        c.addView(spacer(dp(20)))

        c.addView(card(
            title = "Что мы делаем с этим разрешением",
            body = """
                Беловик использует доступ к содержимому экрана, чтобы вставить распознанный голос в текущее текстовое поле — точно туда, где вы поставили курсор.

                Что мы НЕ делаем:
                • Не читаем содержимое полей паролей и кредитных карт
                • Не сохраняем содержимое экрана
                • Не отправляем никаких данных кроме самой аудио-записи на наш сервер транскрипции

                Аудио передаётся по HTTPS на сервер транскрипции, обрабатывается и сразу удаляется. Текст возвращается на устройство и вставляется локально.
            """.trimIndent(),
        ))

        c.addView(spacer(dp(16)))
        c.addView(card(
            title = "После открытия настроек",
            body = """
                1. Найдите раздел «Скачанные приложения»
                2. Тапните по «Беловик»
                3. Включите главный тумблер
                4. Не включайте «Быстрый запуск функции» (shortcut) — он не нужен
                5. Вернитесь в приложение
            """.trimIndent(),
        ))
        c.addView(spacer(dp(32)))
        if (hasA11y()) {
            c.addView(grantedRow("Спец. возможности включены"))
            c.addView(spacer(dp(20)))
            c.addView(primaryButton("Дальше") { advance() })
        } else {
            c.addView(primaryButton("Открыть настройки") { openAccessibilitySettings() })
            c.addView(spacer(dp(8)))
            c.addView(secondaryButton("Пропустить пока") { advance() })
        }
    }

    private fun renderNotificationsStep(c: LinearLayout) {
        c.addView(displayHeadline("Уведомления"))
        c.addView(spacer(dp(16)))
        c.addView(subtext("Уведомление в шторке показывает что Беловик активен и даёт быстрый доступ к диктовке. Без него тоже всё работает."))
        c.addView(spacer(dp(32)))
        if (hasNotifications()) {
            c.addView(grantedRow("Уведомления разрешены"))
            c.addView(spacer(dp(20)))
            c.addView(primaryButton("Дальше") { advance() })
        } else if (Build.VERSION.SDK_INT >= 33) {
            c.addView(primaryButton("Разрешить уведомления") { requestNotificationPermission() })
            c.addView(spacer(dp(8)))
            c.addView(secondaryButton("Пропустить") { advance() })
        } else {
            advance()
        }
    }

    private fun renderDone(c: LinearLayout) {
        c.addView(displayHeadline("Готово"))
        c.addView(spacer(dp(20)))
        c.addView(subtext("Откройте Telegram, заметки или любое приложение с текстовым полем. Тапните в поле — появится кнопка-микрофон. Удержание = быстрая диктовка."))
        c.addView(spacer(dp(32)))
        c.addView(primaryButton("Включить Беловик") {
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

        c.addView(displayHeadline("Беловик"))
        c.addView(spacer(dp(4)))
        c.addView(subtext("Голосовой интерфейс для работы с текстом"))
        c.addView(spacer(dp(28)))

        val running = WisprService.instance != null
        c.addView(serviceToggleCard(running))
        c.addView(spacer(dp(16)))

        c.addView(styleCard())
        c.addView(spacer(dp(16)))

        c.addView(accountCard())
        c.addView(spacer(dp(16)))

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
            "Без них Беловик не сможет вставить распознанный текст в активное поле.",
            "Открыть настройки",
        ) { openAccessibilitySettings() })

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

        c.addView(spacer(dp(20)))
        c.addView(secondaryButton("Пройти онбординг заново") {
            OnboardingState.reset(this)
            currentStep = Step.WELCOME
            renderForState()
        })
    }

    private fun serviceToggleCard(running: Boolean): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(20))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(20).toFloat()
                setColor(col(R.color.surface_1))
                setStroke(dp(1), col(R.color.border_subtle))
            }
        }
        card.addView(TextView(this).apply {
            text = if (running) "Сервис активен" else "Сервис не запущен"
            setTextColor(if (running) col(R.color.success) else col(R.color.text_primary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(6)))
        card.addView(TextView(this).apply {
            text = if (running) "Беловик работает в фоне. Тапните в любое текстовое поле — появится кнопка."
            else "Запустите фоновый сервис чтобы кнопка появлялась автоматически."
            setTextColor(col(R.color.text_secondary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setLineSpacing(0f, 1.4f)
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

    private fun accountCard(): View {
        val email = AuthStore.email(this) ?: "—"
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(20))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(20).toFloat()
                setColor(col(R.color.surface_1))
                setStroke(dp(1), col(R.color.border_subtle))
            }
        }
        card.addView(TextView(this).apply {
            text = "Аккаунт"
            setTextColor(col(R.color.text_primary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(6)))
        card.addView(TextView(this).apply {
            text = email
            setTextColor(col(R.color.text_secondary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        })
        card.addView(spacer(dp(12)))
        card.addView(secondaryButton("Установить / сменить пароль") {
            startActivity(Intent(this, SetPasswordActivity::class.java))
        })
        card.addView(spacer(dp(8)))
        card.addView(secondaryButton("Выйти") {
            // Best-effort server logout; offline-tolerant. Runs on a
            // background thread because OkHttp forbids network on main.
            val token = AuthStore.token(this)
            if (token != null) {
                Thread { AuthClient.logout(token) }.start()
            }
            AuthStore.clear(this)
            // Stop the foreground service too — without a token it can't
            // hit /transcribe anyway, and re-login will restart it.
            WisprService.stop(this)
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
        })
        return card
    }

    private fun styleCard(): View {
        val current = StyleStore.get(this)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(20))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(20).toFloat()
                setColor(col(R.color.surface_1))
                setStroke(dp(1), col(R.color.border_subtle))
            }
            isClickable = true
            isFocusable = true
            setOnClickListener { showStyleDialog() }
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(this).apply {
            text = "Стиль обработки"
            setTextColor(col(R.color.text_primary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        header.addView(TextView(this).apply {
            text = current.label
            setTextColor(col(R.color.graphite))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        header.addView(TextView(this).apply {
            text = "  ›"
            setTextColor(col(R.color.text_tertiary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        })
        card.addView(header)
        card.addView(spacer(dp(6)))
        card.addView(TextView(this).apply {
            text = current.hint
            setTextColor(col(R.color.text_secondary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setLineSpacing(0f, 1.4f)
        })
        return card
    }

    private fun showStyleDialog() {
        val styles = DictationStyle.entries
        val labels = styles.map { "${it.label}\n${it.hint}" }.toTypedArray()
        val current = StyleStore.get(this)
        val checkedIndex = styles.indexOf(current).coerceAtLeast(0)

        AlertDialog.Builder(this)
            .setTitle("Стиль обработки")
            .setSingleChoiceItems(labels, checkedIndex) { dialog, which ->
                StyleStore.set(this, styles[which])
                dialog.dismiss()
                renderForState() // refresh card with new selection
            }
            .setNegativeButton("Отмена", null)
            .show()
    }

    private fun gateBanner(
        title: String,
        body: String,
        cta: String,
        action: () -> Unit,
    ): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(14).toFloat()
                setColor(col(R.color.surface_mint))
                setStroke(dp(1), col(R.color.border_subtle))
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(12) }
        }
        card.addView(TextView(this).apply {
            text = "·  $title"
            setTextColor(col(R.color.text_primary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(4)))
        card.addView(TextView(this).apply {
            text = body
            setTextColor(col(R.color.text_secondary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setLineSpacing(0f, 1.4f)
        })
        card.addView(spacer(dp(12)))
        val btn = primaryButton(cta) { action() }
        card.addView(btn)
        return card
    }

    // ─── Reusable view-builders ────────────────────────────────────────────

    private fun displayHeadline(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(col(R.color.text_primary))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
        // serif-like display fall-through; system Fraunces isn't available so
        // we lean on a weight + letter-spacing combo for the "soft display" feel.
        typeface = android.graphics.Typeface.SERIF
        letterSpacing = -0.02f
    }

    private fun subtext(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(col(R.color.text_secondary))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setLineSpacing(0f, 1.4f)
    }

    private fun stepItem(num: Int, text: String): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val numView = TextView(this).apply {
            this.text = num.toString()
            setTextColor(col(R.color.text_inverse))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(col(R.color.graphite))
            }
            layoutParams = LinearLayout.LayoutParams(dp(28), dp(28)).apply {
                marginEnd = dp(14)
            }
        }
        row.addView(numView)
        row.addView(TextView(this).apply {
            this.text = text
            setTextColor(col(R.color.text_primary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        })
        return row
    }

    private fun card(title: String, body: String): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(20))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(20).toFloat()
                setColor(col(R.color.surface_1))
                setStroke(dp(1), col(R.color.border_subtle))
            }
        }
        card.addView(TextView(this).apply {
            this.text = title
            setTextColor(col(R.color.text_primary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(8)))
        card.addView(TextView(this).apply {
            this.text = body
            setTextColor(col(R.color.text_secondary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setLineSpacing(0f, 1.5f)
        })
        return card
    }

    private fun grantedRow(text: String): View {
        return TextView(this).apply {
            this.text = "✓  $text"
            setTextColor(col(R.color.success))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
    }

    private fun primaryButton(text: String, action: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            isAllCaps = false
            setTextColor(col(R.color.text_inverse))
            setBackgroundColor(col(R.color.graphite))
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
            setTextColor(col(R.color.text_secondary))
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
