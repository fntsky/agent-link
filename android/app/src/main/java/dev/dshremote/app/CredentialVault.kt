package dev.dshremote.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.dshremote.core.DeviceIdentity
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Profile(val endpoint: String, val harness: String = "", val user: String = "", val relayId: String = "", val pairingCode: String = "", val pairingOperation: String = "")
data class PendingSend(val endpoint: String, val harness: String, val session: String, val text: String, val mode: Int, val operation: String, val message: String)

/** Ed25519 seed and recovery receipts are AES-GCM encrypted with a non-exportable Keystore key. */
class CredentialVault(context: Context) {
    private val preferences = context.getSharedPreferences("device-vault", Context.MODE_PRIVATE)
    private val key: SecretKey = KeyStore.getInstance("AndroidKeyStore").run {
        load(null)
        (getKey("dsh-remote-v1", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder("dsh-remote-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    private val data: JSONObject = preferences.getString("sealed", null)?.let { sealed ->
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    } ?: JSONObject().put("device", DeviceIdentity.newId()).put("seed", Base64.encodeToString(DeviceIdentity.newSeed(), Base64.NO_WRAP)).also { persist(it) }
    val identity = DeviceIdentity(data.getString("device"), Base64.decode(data.getString("seed"), Base64.NO_WRAP))
    var profile: Profile?
        get() = data.optJSONObject("profile")?.let { Profile(it.getString("endpoint"), it.optString("harness"), it.optString("user"), it.optString("relay"), it.optString("code"), it.optString("operation")) }
        set(value) {
            if (value == null) data.remove("profile") else data.put("profile", JSONObject().put("endpoint", value.endpoint).put("harness", value.harness).put("user", value.user).put("relay", value.relayId).put("code", value.pairingCode).put("operation", value.pairingOperation))
            persist(data)
        }
    var pendingSend: PendingSend?
        get() = data.optJSONObject("send")?.let { PendingSend(it.getString("endpoint"), it.getString("harness"), it.getString("session"), it.getString("text"), it.getInt("mode"), it.getString("operation"), it.getString("message")) }
        set(value) {
            if (value == null) data.remove("send") else data.put("send", JSONObject().put("endpoint", value.endpoint).put("harness", value.harness).put("session", value.session).put("text", value.text).put("mode", value.mode).put("operation", value.operation).put("message", value.message))
            persist(data)
        }
    fun operation(name: String): String {
        val operations = data.optJSONObject("operations") ?: JSONObject().also { data.put("operations", it) }
        return if (operations.has(name)) operations.getString(name) else DeviceIdentity.newId().also { operations.put(name, it); persist(data) }
    }
    fun finishOperation(name: String) { data.optJSONObject("operations")?.remove(name); persist(data) }
    private fun persist(value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val sealed = cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        check(preferences.edit().putString("sealed", Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) { "设备凭证保存失败" }
    }
}
