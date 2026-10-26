package dev.dshremote.core

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.SecureRandom
import java.util.UUID

/** Seed storage is supplied by Android Keystore encryption; this class never logs it. */
class DeviceIdentity(val deviceId: String, seed: ByteArray) {
    private val key = Ed25519PrivateKeyParameters(seed.copyOf(), 0)
    val publicKey: ByteArray get() = key.generatePublicKey().encoded
    fun sign(message: ByteArray): ByteArray = Ed25519Signer().run {
        init(true, key)
        update(message, 0, message.size)
        generateSignature()
    }
    companion object {
        fun newSeed(): ByteArray = ByteArray(32).also(SecureRandom()::nextBytes)
        fun newId(): String = UUID.randomUUID().toString()
        fun transcript(prefix: String, vararg parts: ByteArray): ByteArray {
            val bytes = ByteArrayOutputStream()
            bytes.write(prefix.toByteArray(Charsets.US_ASCII))
            DataOutputStream(bytes).use { output ->
                parts.forEach { output.writeInt(it.size); output.write(it) }
            }
            return bytes.toByteArray()
        }
    }
}
