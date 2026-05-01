package com.wispralt.keyboard

import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Two-step email magic-link / OTP login. Mirrors the desktop and iOS auth
 * gates. On success, persists the JWT via [AuthStore] and routes to
 * [MainActivity]. Shown on first launch and after any 401 from the
 * backend (handled in [OverlayController]).
 */
class LoginActivity : AppCompatActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private lateinit var root: LinearLayout
    private var pendingEmail: String = ""

    private fun col(id: Int): Int = ContextCompat.getColor(this, id)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildShell())
        renderEmailStep()
        handleDeepLinkIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLinkIntent(intent)
    }

    /**
     * Handles `belovik://auth?token=…&email=…` opened from the magic-link
     * email. If a token is present we save the session and finish; the
     * caller (MainActivity) re-checks AuthStore on resume and continues.
     *
     * Email is preferred from the URL when provided so the UI shows the
     * right address; otherwise we fall back to whatever was already typed.
     */
    private fun handleDeepLinkIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        if (uri.scheme != "belovik" || uri.host != "auth") return
        val token = uri.getQueryParameter("token")?.takeIf { it.isNotBlank() } ?: return
        val emailFromLink = uri.getQueryParameter("email")?.takeIf { it.isNotBlank() }
            ?: AuthStore.email(this)
            ?: pendingEmail.takeIf { it.isNotBlank() }
            ?: ""
        AuthStore.save(this, token, emailFromLink)
        startActivity(Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        })
        finish()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun buildShell(): View {
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(col(R.color.bg_base))
        }
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0,
            ).apply { weight = 1f }
        }
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(72), dp(28), dp(32))
        }
        scroll.addView(root)
        outer.addView(scroll)
        return outer
    }

    // ─── Steps ─────────────────────────────────────────────────────────────

    private fun renderEmailStep() {
        root.removeAllViews()
        root.addView(displayHeadline("А-ГОЛОС"))
        root.addView(spacer(dp(8)))
        root.addView(subtext("Скажите мысль. Получите текст."))
        root.addView(spacer(dp(48)))

        root.addView(card(
            title = "Вход",
            body = "Email для входа. Продолжим за один шаг.",
        ))
        root.addView(spacer(dp(20)))

        val emailField = textField(
            hint = "you@example.com",
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
        )
        root.addView(emailField)
        root.addView(spacer(dp(16)))

        val errorView = errorRow()
        root.addView(errorView)

        val submit = primaryButton("Продолжить") { /* set below */ }
        root.addView(submit)

        submit.setOnClickListener {
            val email = emailField.text.toString().trim().lowercase()
            if (!email.matches(EMAIL_RE)) {
                errorView.show("Неверный email")
                return@setOnClickListener
            }
            errorView.hide()
            submit.isEnabled = false
            submit.text = "Проверяем…"
            scope.launch {
                val status = withContext(Dispatchers.IO) { AuthClient.checkEmail(email) }
                submit.isEnabled = true
                submit.text = "Продолжить"
                when (status) {
                    is AuthClient.Result.Ok -> {
                        pendingEmail = email
                        if (status.value.hasPassword) {
                            renderPasswordStep()
                        } else {
                            requestOtpAndShowCodeStep(errorView)
                        }
                    }
                    is AuthClient.Result.Err -> errorView.show(status.message)
                }
            }
        }
    }

    private fun renderPasswordStep() {
        root.removeAllViews()
        root.addView(displayHeadline("Введите пароль"))
        root.addView(spacer(dp(8)))
        root.addView(subtext("Аккаунт $pendingEmail."))
        root.addView(spacer(dp(32)))

        val pwField = textField(
            hint = "Пароль",
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        )
        root.addView(pwField)
        root.addView(spacer(dp(16)))

        val errorView = errorRow()
        root.addView(errorView)

        val submit = primaryButton("Войти") { /* set below */ }
        root.addView(submit)
        root.addView(spacer(dp(8)))

        root.addView(secondaryButton("Войти по коду из почты") {
            requestOtpAndShowCodeStep(errorView)
        })
        root.addView(secondaryButton("Указать другой email") {
            pendingEmail = ""
            renderEmailStep()
        })

        submit.setOnClickListener {
            val password = pwField.text.toString()
            if (password.isEmpty()) return@setOnClickListener
            errorView.hide()
            submit.isEnabled = false
            submit.text = "Входим…"
            scope.launch {
                val res = withContext(Dispatchers.IO) {
                    AuthClient.login(pendingEmail, password)
                }
                submit.isEnabled = true
                submit.text = "Войти"
                when (res) {
                    is AuthClient.Result.Ok -> {
                        AuthStore.save(this@LoginActivity, res.value.token, res.value.email)
                        finish()
                    }
                    is AuthClient.Result.Err -> errorView.show(res.message)
                }
            }
        }
    }

    /**
     * Sends an OTP code to [pendingEmail] and routes to the code step on
     * success, surfacing failures in [errorView]. Used both as the default
     * path for password-less accounts and as the "забыли пароль" fallback.
     */
    private fun requestOtpAndShowCodeStep(errorView: TextView) {
        scope.launch {
            val res = withContext(Dispatchers.IO) { AuthClient.requestCode(pendingEmail) }
            when (res) {
                is AuthClient.Result.Ok -> renderCodeStep()
                is AuthClient.Result.Err -> errorView.show(res.message)
            }
        }
    }

    private fun renderCodeStep() {
        root.removeAllViews()
        root.addView(displayHeadline("Введите код"))
        root.addView(spacer(dp(16)))
        root.addView(subtext("Код отправлен на $pendingEmail. Действует 10 минут."))
        root.addView(spacer(dp(32)))

        val codeField = textField(
            hint = "123456",
            inputType = InputType.TYPE_CLASS_NUMBER,
            largeMonospace = true,
        ).apply { filters = arrayOf(android.text.InputFilter.LengthFilter(6)) }
        root.addView(codeField)
        root.addView(spacer(dp(16)))

        val errorView = errorRow()
        root.addView(errorView)

        val submit = primaryButton("Войти") { /* set below */ }
        root.addView(submit)
        root.addView(spacer(dp(8)))

        val back = secondaryButton("Указать другой email") {
            pendingEmail = ""
            renderEmailStep()
        }
        root.addView(back)

        submit.setOnClickListener {
            val code = codeField.text.toString().trim()
            if (!code.matches(Regex("^\\d{6}$"))) {
                errorView.show("Код состоит из 6 цифр")
                return@setOnClickListener
            }
            errorView.hide()
            submit.isEnabled = false
            submit.text = "Проверяем…"
            scope.launch {
                val res = withContext(Dispatchers.IO) {
                    AuthClient.verifyCode(pendingEmail, code)
                }
                submit.isEnabled = true
                submit.text = "Войти"
                when (res) {
                    is AuthClient.Result.Ok -> {
                        val session = res.value
                        AuthStore.save(this@LoginActivity, session.token, session.email)
                        finish()
                    }
                    is AuthClient.Result.Err -> errorView.show(res.message)
                }
            }
        }
    }

    // ─── UI helpers (mirror MainActivity tokens) ────────────────────────────

    private fun displayHeadline(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(col(R.color.text_primary))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 36f)
        typeface = android.graphics.Typeface.DEFAULT_BOLD
    }

    private fun subtext(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(col(R.color.text_secondary))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setLineSpacing(0f, 1.4f)
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
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(spacer(dp(6)))
        card.addView(TextView(this).apply {
            this.text = body
            setTextColor(col(R.color.text_secondary))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setLineSpacing(0f, 1.5f)
        })
        return card
    }

    private fun textField(
        hint: String,
        inputType: Int,
        largeMonospace: Boolean = false,
    ): EditText = EditText(this).apply {
        this.hint = hint
        setHintTextColor(col(R.color.text_secondary))
        setTextColor(col(R.color.text_primary))
        this.inputType = inputType
        background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            cornerRadius = dp(14).toFloat()
            setColor(col(R.color.surface_sunk))
            setStroke(dp(1), col(R.color.border_subtle))
        }
        setPadding(dp(16), dp(14), dp(16), dp(14))
        if (largeMonospace) {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            typeface = android.graphics.Typeface.MONOSPACE
            gravity = Gravity.CENTER
            letterSpacing = 0.4f
        } else {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
    }

    private fun errorRow(): TextView = TextView(this).apply {
        setTextColor(0xFFB94545.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(0x14B94545)
        }
        setPadding(dp(12), dp(10), dp(12), dp(10))
        visibility = View.GONE
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { bottomMargin = dp(12) }
    }

    private fun TextView.show(message: String) {
        text = message
        visibility = View.VISIBLE
    }

    private fun TextView.hide() {
        text = ""
        visibility = View.GONE
    }

    private fun primaryButton(text: String, action: () -> Unit): Button =
        Button(this).apply {
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

    private fun secondaryButton(text: String, action: () -> Unit): Button =
        Button(this).apply {
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

    private fun spacer(height: Int): View = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, height,
        )
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt().coerceAtLeast(1)

    companion object {
        private val EMAIL_RE = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
    }
}
