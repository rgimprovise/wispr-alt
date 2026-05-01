package com.wispralt.keyboard

import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
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
 * Lets the signed-in user set or change their password. Reads
 * AuthClient.checkEmail() to know whether to require currentPassword.
 * Shown from MainActivity's "Установить/Сменить пароль" button.
 */
class SetPasswordActivity : AppCompatActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var root: LinearLayout
    private var hasExistingPassword: Boolean = false

    private fun col(id: Int): Int = ContextCompat.getColor(this, id)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!AuthStore.isSignedIn(this)) { finish(); return }
        setContentView(buildShell())
        loadStateAndRender()
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

    private fun loadStateAndRender() {
        val email = AuthStore.email(this) ?: return
        scope.launch {
            val status = withContext(Dispatchers.IO) { AuthClient.checkEmail(email) }
            hasExistingPassword = (status as? AuthClient.Result.Ok)
                ?.value?.hasPassword == true
            renderForm()
        }
    }

    private fun renderForm() {
        root.removeAllViews()

        val title = if (hasExistingPassword) "Сменить пароль" else "Установить пароль"
        root.addView(headline(title))
        root.addView(spacer(dp(8)))
        root.addView(subtext("Минимум 8 символов. Используется для быстрого входа без кода из почты."))
        root.addView(spacer(dp(28)))

        val currentField = if (hasExistingPassword) {
            textField(
                hint = "Текущий пароль",
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
            ).also {
                root.addView(it)
                root.addView(spacer(dp(12)))
            }
        } else null

        val newField = textField(
            hint = "Новый пароль",
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        )
        root.addView(newField)
        root.addView(spacer(dp(12)))

        val confirmField = textField(
            hint = "Повторите пароль",
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        )
        root.addView(confirmField)
        root.addView(spacer(dp(16)))

        val errorView = errorRow()
        root.addView(errorView)
        val successView = successRow()
        root.addView(successView)

        val submit = primaryButton("Сохранить") { /* set below */ }
        root.addView(submit)
        root.addView(spacer(dp(8)))
        root.addView(secondaryButton("Назад") { finish() })

        submit.setOnClickListener {
            successView.visibility = View.GONE
            errorView.visibility = View.GONE
            val newVal = newField.text.toString()
            val confirmVal = confirmField.text.toString()
            val curVal = currentField?.text?.toString().orEmpty()
            if (newVal.length < 8) {
                errorView.show("Пароль должен быть минимум 8 символов")
                return@setOnClickListener
            }
            if (newVal != confirmVal) {
                errorView.show("Пароли не совпадают")
                return@setOnClickListener
            }
            if (hasExistingPassword && curVal.isEmpty()) {
                errorView.show("Введите текущий пароль")
                return@setOnClickListener
            }
            val token = AuthStore.token(this) ?: run {
                errorView.show("Сессия истекла, войдите заново")
                return@setOnClickListener
            }
            submit.isEnabled = false
            submit.text = "Сохраняем…"
            scope.launch {
                val res = withContext(Dispatchers.IO) {
                    AuthClient.setPassword(
                        token = token,
                        newPassword = newVal,
                        currentPassword = curVal.ifBlank { null },
                    )
                }
                submit.isEnabled = true
                submit.text = "Сохранить"
                when (res) {
                    is AuthClient.Result.Ok -> {
                        successView.show("Пароль сохранён")
                        newField.text.clear()
                        confirmField.text.clear()
                        currentField?.text?.clear()
                        hasExistingPassword = true
                    }
                    is AuthClient.Result.Err -> errorView.show(res.message)
                }
            }
        }
    }

    // ─── UI helpers (mirror LoginActivity) ─────────────────────────────────

    private fun headline(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(col(R.color.text_primary))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
        typeface = android.graphics.Typeface.DEFAULT_BOLD
    }

    private fun subtext(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(col(R.color.text_secondary))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setLineSpacing(0f, 1.4f)
    }

    private fun textField(hint: String, inputType: Int): EditText = EditText(this).apply {
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
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    }

    private fun errorRow() = TextView(this).apply {
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

    private fun successRow() = TextView(this).apply {
        setTextColor(0xFF4A7A5C.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(0x144A7A5C)
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

    private fun primaryButton(text: String, action: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        setTextColor(col(R.color.text_inverse))
        setBackgroundColor(col(R.color.graphite))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        typeface = android.graphics.Typeface.DEFAULT_BOLD
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(52),
        )
    }

    private fun secondaryButton(text: String, action: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        setTextColor(col(R.color.text_secondary))
        setBackgroundColor(0x00000000)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(44),
        )
    }

    private fun spacer(height: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, height,
        )
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt().coerceAtLeast(1)
}
