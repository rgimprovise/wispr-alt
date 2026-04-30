package com.wispralt.keyboard

import android.content.Context

/**
 * Available cleanup styles. Must mirror the `Style` union in
 * backend/src/transcribe.ts AND iOS DictationStyle.
 */
enum class DictationStyle(
    val raw: String,
    val label: String,
    val hint: String,
) {
    CLEAN(    "clean",    "Чистка",       "Снять «эээ», расставить пунктуацию, разбить на абзацы"),
    BUSINESS( "business", "Деловой",      "Формальный рабочий тон, активный залог, структура"),
    CASUAL(   "casual",   "Неформальный", "Сохранить разговорный тон, мягкая чистка"),
    BRIEF(    "brief",    "Краткий",      "Только суть, маркированные пункты"),
    TELEGRAM( "telegram", "Telegram",     "Структурированный пост: крючок, абзацы, без эмодзи"),
    EMAIL(    "email",    "Email",        "Письмо с приветствием, темами и подписью"),
    TASK(     "task",     "Задача",       "Action-item: контекст, что сделать, срок"),
    ;

    companion object {
        fun fromRaw(raw: String?): DictationStyle =
            entries.firstOrNull { it.raw == raw } ?: CLEAN
    }
}

/** Persists the user's preferred dictation style in SharedPreferences. */
object StyleStore {
    private const val PREFS = "wispr-alt-style"
    private const val KEY = "style"

    fun get(ctx: Context): DictationStyle {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY, DictationStyle.CLEAN.raw)
        return DictationStyle.fromRaw(raw)
    }

    fun set(ctx: Context, style: DictationStyle) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, style.raw)
            .apply()
    }
}
