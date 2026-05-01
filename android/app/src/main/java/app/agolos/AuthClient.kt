package app.agolos

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Thin OkHttp wrapper around /auth/request and /auth/verify on the
 * backend. Pure I/O, no Android types — call from a background thread.
 */
object AuthClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json".toMediaType()

    sealed class Result<out T> {
        data class Ok<T>(val value: T) : Result<T>()
        data class Err(val message: String) : Result<Nothing>()
    }

    /** POST /auth/request — emails a 6-digit code to [email]. */
    fun requestCode(email: String): Result<Unit> {
        val body = JSONObject().put("email", email).toString()
            .toRequestBody(JSON)
        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/auth/request")
            .post(body)
            .build()
        return runCatching {
            http.newCall(req).execute().use { res ->
                if (res.isSuccessful) Result.Ok(Unit)
                else Result.Err(parseError(res.body?.string()) ?: "HTTP ${res.code}")
            }
        }.getOrElse { Result.Err(it.message ?: "network error") }
    }

    data class Session(val token: String, val email: String)
    data class EmailStatus(val exists: Boolean, val hasPassword: Boolean)

    /** POST /auth/check-email — tells the client password vs OTP path. */
    fun checkEmail(email: String): Result<EmailStatus> {
        val body = JSONObject().put("email", email).toString().toRequestBody(JSON)
        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/auth/check-email")
            .post(body)
            .build()
        return runCatching {
            http.newCall(req).execute().use { res ->
                val text = res.body?.string()
                if (!res.isSuccessful) {
                    return Result.Err(parseError(text) ?: "HTTP ${res.code}")
                }
                val json = JSONObject(text ?: "{}")
                Result.Ok(EmailStatus(
                    exists = json.optBoolean("exists"),
                    hasPassword = json.optBoolean("hasPassword"),
                ))
            }
        }.getOrElse { Result.Err(it.message ?: "network error") }
    }

    /** POST /auth/login — email + password → JWT. */
    fun login(email: String, password: String): Result<Session> {
        val body = JSONObject()
            .put("email", email)
            .put("password", password)
            .toString()
            .toRequestBody(JSON)
        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/auth/login")
            .post(body)
            .build()
        return runCatching {
            http.newCall(req).execute().use { res ->
                val text = res.body?.string()
                if (!res.isSuccessful) {
                    return Result.Err(parseError(text) ?: "HTTP ${res.code}")
                }
                val json = JSONObject(text ?: "{}")
                val token = json.optString("token").ifBlank { return Result.Err("missing token") }
                val verifiedEmail = json.optJSONObject("user")
                    ?.optString("email").orEmpty().ifBlank { email }
                Result.Ok(Session(token, verifiedEmail))
            }
        }.getOrElse { Result.Err(it.message ?: "network error") }
    }

    /**
     * POST /auth/set-password — requires Bearer auth. [currentPassword]
     * is only required when the user already has a password set.
     */
    fun setPassword(token: String, newPassword: String, currentPassword: String?): Result<Unit> {
        val payload = JSONObject().put("newPassword", newPassword)
        if (!currentPassword.isNullOrBlank()) {
            payload.put("currentPassword", currentPassword)
        }
        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/auth/set-password")
            .header("Authorization", "Bearer $token")
            .post(payload.toString().toRequestBody(JSON))
            .build()
        return runCatching {
            http.newCall(req).execute().use { res ->
                if (res.isSuccessful) Result.Ok(Unit)
                else Result.Err(parseError(res.body?.string()) ?: "HTTP ${res.code}")
            }
        }.getOrElse { Result.Err(it.message ?: "network error") }
    }

    /** POST /auth/logout — best-effort acknowledgement. */
    fun logout(token: String) {
        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/auth/logout")
            .header("Authorization", "Bearer $token")
            .post("".toRequestBody(JSON))
            .build()
        runCatching { http.newCall(req).execute().close() }
    }

    /** POST /auth/verify — exchanges the 6-digit code for a JWT. */
    fun verifyCode(email: String, code: String): Result<Session> {
        val body = JSONObject()
            .put("email", email)
            .put("code", code)
            .toString()
            .toRequestBody(JSON)
        val req = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/auth/verify")
            .post(body)
            .build()
        return runCatching {
            http.newCall(req).execute().use { res ->
                val text = res.body?.string()
                if (!res.isSuccessful) {
                    return Result.Err(parseError(text) ?: "HTTP ${res.code}")
                }
                val json = JSONObject(text ?: "{}")
                val token = json.optString("token").ifBlank { return Result.Err("missing token") }
                val user = json.optJSONObject("user")
                val verifiedEmail = user?.optString("email").orEmpty()
                    .ifBlank { email }
                Result.Ok(Session(token, verifiedEmail))
            }
        }.getOrElse { Result.Err(it.message ?: "network error") }
    }

    private fun parseError(body: String?): String? {
        if (body.isNullOrBlank()) return null
        return runCatching { JSONObject(body).optString("error").takeIf { it.isNotBlank() } }
            .getOrNull()
    }
}
