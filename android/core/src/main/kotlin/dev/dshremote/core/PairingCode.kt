package dev.dshremote.core

/**
 * Six-character Crockford base32 pairing codes. The alphabet omits I/L/O/U, so
 * pasted input can be folded without ambiguity. The Relay applies the same
 * normalisation before looking the code up, and hashes only the canonical form.
 */
object PairingCode {
    const val LENGTH = 6

    fun normalize(raw: String): String = buildString(raw.length) {
        for (c in raw.uppercase()) {
            when (c) {
                ' ', '\t', '\n', '\r', '-', '_' -> Unit
                'I', 'L' -> append('1')
                'O' -> append('0')
                'U' -> append('V')
                else -> append(c)
            }
        }
    }

    /** Groups a canonical code as `ABC-DEF` for display and manual copying. */
    fun display(code: String): String =
        if (code.length == LENGTH) "${code.take(3)}-${code.drop(3)}" else code
}
