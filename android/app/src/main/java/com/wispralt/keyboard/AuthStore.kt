package com.wispralt.keyboard

import android.content.Context

/**
 * Persists the JWT issued by /auth/verify, plus the user's email for the
 * "logged in as …" UI. Plain SharedPreferences for now — same security
 * level as the desktop's settings.json, fine for a 30-day token. Move to
 * EncryptedSharedPreferences when threat model demands it.
 */
object AuthStore {
    private const val PREFS = "wispr-alt-auth"
    private const val KEY_TOKEN = "token"
    private const val KEY_EMAIL = "email"

    fun token(ctx: Context): String? =
        prefs(ctx).getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun email(ctx: Context): String? =
        prefs(ctx).getString(KEY_EMAIL, null)?.takeIf { it.isNotBlank() }

    fun isSignedIn(ctx: Context): Boolean = token(ctx) != null

    fun save(ctx: Context, token: String, email: String) {
        prefs(ctx).edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_EMAIL, email)
            .apply()
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit()
            .remove(KEY_TOKEN)
            .remove(KEY_EMAIL)
            .apply()
    }

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
