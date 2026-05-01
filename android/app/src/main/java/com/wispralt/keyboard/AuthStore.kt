package com.wispralt.keyboard

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Persists the JWT issued by /auth/verify, plus the user's email.
 *
 * v0.8.2 and earlier stored these in plain SharedPreferences. v0.8.3+
 * uses EncryptedSharedPreferences (AES-256-GCM, key wrapped by an
 * AndroidKeyStore-backed master key), with a one-shot migration from the
 * plain prefs on first read after upgrade.
 */
object AuthStore {
    private const val LEGACY_PREFS = "wispr-alt-auth"
    private const val ENC_PREFS = "wispr-alt-auth-enc"
    private const val KEY_TOKEN = "token"
    private const val KEY_EMAIL = "email"
    private const val TAG = "AuthStore"

    @Volatile private var encrypted: SharedPreferences? = null

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

    /**
     * Returns the EncryptedSharedPreferences singleton, falling back to
     * plain prefs only if the security library blows up (e.g. the master
     * key got wiped by a backup-restore). Falling back keeps the user
     * signed in rather than dropping their session on a recoverable error.
     */
    private fun prefs(ctx: Context): SharedPreferences {
        encrypted?.let { return it }
        synchronized(this) {
            encrypted?.let { return it }
            val enc = openEncrypted(ctx) ?: run {
                Log.w(TAG, "encrypted prefs unavailable; using plain")
                return ctx.applicationContext
                    .getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
            }
            migrateLegacyIfNeeded(ctx, enc)
            encrypted = enc
            return enc
        }
    }

    private fun openEncrypted(ctx: Context): SharedPreferences? = runCatching {
        val masterKey = MasterKey.Builder(ctx.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            ctx.applicationContext,
            ENC_PREFS,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.onFailure { Log.e(TAG, "EncryptedSharedPreferences.create failed", it) }
        .getOrNull()

    private fun migrateLegacyIfNeeded(ctx: Context, enc: SharedPreferences) {
        val legacy = ctx.applicationContext
            .getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
        val legacyToken = legacy.getString(KEY_TOKEN, null)
        if (legacyToken.isNullOrBlank()) return
        if (!enc.getString(KEY_TOKEN, null).isNullOrBlank()) {
            // Already migrated; just nuke the plaintext as belt-and-suspenders.
            legacy.edit().clear().apply()
            return
        }
        val legacyEmail = legacy.getString(KEY_EMAIL, null).orEmpty()
        enc.edit()
            .putString(KEY_TOKEN, legacyToken)
            .putString(KEY_EMAIL, legacyEmail)
            .apply()
        legacy.edit().clear().apply()
        Log.i(TAG, "migrated auth session from plain to encrypted prefs")
    }
}
