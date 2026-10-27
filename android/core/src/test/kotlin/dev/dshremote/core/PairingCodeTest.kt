package dev.dshremote.core

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingCodeTest {
    @Test fun pastedCodesFoldOntoTheCanonicalForm() {
        assertEquals("7K3M2P", PairingCode.normalize(" 7k3-m2p "))
        assertEquals("7K3M2P", PairingCode.normalize("7K3M2P"))
        // The alphabet omits these characters, so lookalikes map onto the symbol
        // the Relay actually generated.
        assertEquals("011V", PairingCode.normalize("oil u"))
        assertEquals("", PairingCode.normalize(" - "))
    }

    @Test fun displayGroupsSixCharacterCodes() {
        assertEquals("ABC-DEF", PairingCode.display("ABCDEF"))
        assertEquals("legacy-code", PairingCode.display("legacy-code"))
    }
}
