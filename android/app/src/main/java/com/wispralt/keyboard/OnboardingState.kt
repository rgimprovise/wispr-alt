package com.wispralt.keyboard

import android.content.Context
import android.content.SharedPreferences

/** Tracks whether the user has completed the onboarding carousel. */
object OnboardingState {
    private const val PREFS = "wispr-alt-onboarding"
    private const val KEY_COMPLETED = "completed"

    fun isCompleted(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_COMPLETED, false)

    fun markCompleted(ctx: Context) {
        prefs(ctx).edit().putBoolean(KEY_COMPLETED, true).apply()
    }

    fun reset(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
