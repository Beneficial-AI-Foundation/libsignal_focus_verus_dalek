# Signal Double Ratchet: Implementation Guide

The Double Ratchet is the core of Signal's end-to-end encryption for 1:1
messaging. It combines a Diffie-Hellman ratchet (for post-compromise security)
with a symmetric-key ratchet (for forward secrecy per message), and now
integrates SPQR for post-quantum security.

All source lives in `rust/protocol/src/`.

## Module map

```
session_cipher.rs               Encrypt/decrypt entry points: message_encrypt(), message_decrypt()
├── session.rs                  Session setup: process_prekey(), process_prekey_bundle()
├── ratchet.rs                  X3DH/PQXDH key agreement + session initialization
│   ├── ratchet/keys.rs         RootKey, ChainKey, MessageKeys — the key hierarchy
│   └── ratchet/params.rs       AliceSignalProtocolParameters, BobSignalProtocolParameters
├── state/session.rs            SessionState, SessionRecord — persistent session storage
└── consts.rs                   Safety bounds: MAX_FORWARD_JUMPS, MAX_MESSAGE_KEYS, etc.
```

Related crates:
- **spqr** — post-quantum ratchet, called from session_cipher and ratchet (see [SPQR-IMPLEMENTATION.md](SPQR-IMPLEMENTATION.md))
- **signal-crypto** — AES-256-CBC encrypt/decrypt for message bodies
- **curve25519-dalek** — X25519 DH agreement underlying `calculate_agreement()`

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│ session_cipher.rs  —  Public API                                  │
│   message_encrypt(): load session → get chain key → PQR send     │
│     → derive message keys → AES-CBC encrypt → MAC → store        │
│   message_decrypt(): load session → try current + previous       │
│     sessions → DH ratchet step if needed → PQR recv → decrypt    │
├──────────────────────────────────────────────────────────────────┤
│ session.rs  —  Session setup                                      │
│   process_prekey_bundle(): Alice initiates via X3DH/PQXDH        │
│   process_prekey(): Bob responds, creates session from PreKey msg │
├──────────────────────────────────────────────────────────────────┤
│ ratchet.rs  —  Key agreement                                      │
│   initialize_alice_session(): X3DH DH calculations + KEM encaps  │
│     + derive root/chain keys + create initial DH ratchet step    │
│   initialize_bob_session(): mirror of Alice with decapsulation    │
├──────────────────────────────────────────────────────────────────┤
│ ratchet/keys.rs  —  Key hierarchy                                 │
│   RootKey::create_chain(): DH ratchet step (HKDF with DH secret) │
│   ChainKey::next_chain_key(): symmetric ratchet step (HMAC)      │
│   ChainKey::message_keys(): derive per-message cipher/MAC/IV     │
│   MessageKeys::derive_keys(): HKDF to split into cipher+MAC+IV  │
└──────────────────────────────────────────────────────────────────┘
```

## The key hierarchy

```
X3DH / PQXDH shared secret (multiple DH + KEM)
  │
  └── HKDF("WhisperText_X25519_SHA-256_CRYSTALS-KYBER-1024")
        │
        ├── RootKey[0] (32B)         — seeds the DH ratchet
        ├── ChainKey[0] (32B)        — seeds the first symmetric chain
        └── PQR auth key (32B)       — seeds SPQR (post-quantum ratchet)

DH Ratchet (on each new ephemeral key exchange):
  RootKey[n] + DH(our_ephemeral, their_ephemeral)
    └── HKDF("WhisperRatchet")
          ├── RootKey[n+1]
          └── ChainKey (new chain, index 0)

Symmetric Ratchet (on each message):
  ChainKey[i]
    ├── HMAC(key, 0x01) → message seed  ──HKDF("WhisperMessageKeys")──►
    │                                       ├── cipher_key (32B, AES-256-CBC)
    │                                       ├── mac_key (32B, HMAC-SHA256)
    │                                       └── iv (16B)
    └── HMAC(key, 0x02) → ChainKey[i+1]

Post-Quantum Ratchet (parallel, mixed in):
  spqr::send() / spqr::recv() → MessageKey (optional)
    └── mixed into MessageKeys::derive_keys() as salt
```

## Session lifecycle

### Session establishment (X3DH / PQXDH)

```
Alice                                                Bob
  │                                                    │
  │  process_prekey_bundle(Bob's PreKeyBundle)         │
  │    ├── verify signed pre-key signature             │
  │    ├── verify kyber pre-key signature              │
  │    └── initialize_alice_session()                  │
  │          ├── DH(Alice_identity, Bob_signed_prekey) │
  │          ├── DH(Alice_base, Bob_identity)          │
  │          ├── DH(Alice_base, Bob_signed_prekey)     │
  │          ├── DH(Alice_base, Bob_one_time_prekey)   │
  │          ├── KEM encapsulate(Bob_kyber_prekey)     │
  │          ├── derive_keys() → RootKey, ChainKey, PQR key
  │          ├── RootKey.create_chain() → sending chain│
  │          └── spqr::initial_state(A2B)              │
  │                                                    │
  ├──── PreKeySignalMessage ────────────────────────►  │
  │     (base_key, identity, kyber_ct, signal_msg)     │
  │                                                    │  process_prekey()
  │                                                    │    └── initialize_bob_session()
  │                                                    │          ├── same DH calculations (reversed)
  │                                                    │          ├── KEM decapsulate
  │                                                    │          └── spqr::initial_state(B2A)
```

### Message encrypt

```
message_encrypt(plaintext)
  │
  ├── load SessionState
  ├── get_sender_chain_key()               → ChainKey at current index
  ├── pq_ratchet_send()                    → (pqr_msg, pqr_key) via spqr::send()
  ├── chain_key.message_keys()             → MessageKeyGenerator (seed + index)
  │     └── .generate_keys(pqr_key)        → MessageKeys (cipher_key, mac_key, iv)
  │           └── HKDF with PQR key as optional salt
  ├── aes_256_cbc_encrypt(plaintext, cipher_key, iv)
  ├── SignalMessage::new(mac_key, ...)      → MAC over message
  ├── set_sender_chain_key(next_chain_key) → advance symmetric ratchet
  └── store session
```

### Message decrypt

```
message_decrypt(ciphertext)
  │
  ├── load SessionRecord (current + previous sessions)
  ├── try decrypt_message_with_state() on each session:
  │     │
  │     ├── get_or_create_chain_key()
  │     │     └── if their_ephemeral is new:  ◄── DH ratchet step
  │     │           ├── RootKey.create_chain(their_ephemeral, our_key) → recv chain
  │     │           ├── RootKey.create_chain(their_ephemeral, new_key) → send chain
  │     │           └── update session state with new chains
  │     │
  │     ├── get_or_create_message_key()
  │     │     └── advance chain_key forward to counter (saving skipped keys)
  │     │
  │     ├── pq_ratchet_recv(pqr_msg)       → pqr_key via spqr::recv()
  │     ├── message_key_gen.generate_keys(pqr_key) → MessageKeys
  │     ├── verify MAC
  │     └── aes_256_cbc_decrypt(body, cipher_key, iv)
  │
  └── if previous session matched: promote_old_session()
```

## Safety bounds

| Constant | Value | File | Purpose |
|---|---|---|---|
| `MAX_FORWARD_JUMPS` | 25,000 | `consts.rs` | Max messages a chain can skip forward (prevents DoS via huge counter) |
| `MAX_MESSAGE_KEYS` | 2,000 | `consts.rs` | Max out-of-order message keys to store per chain |
| `MAX_RECEIVER_CHAINS` | 5 | `consts.rs` | Max receiver chains per session (DH ratchet steps) |
| `ARCHIVED_STATES_MAX_LENGTH` | 40 | `consts.rs` | Max previous sessions to keep for decryption fallback |
| `MAX_SENDER_KEY_STATES` | 5 | `consts.rs` | Max sender key states (for group messaging) |
| `MAX_UNACKNOWLEDGED_SESSION_AGE` | 30 days | `consts.rs` | Sessions without a response older than this are considered stale |

## Key functions for call graphs

Call graph links point to the [SCIP Call Graph Viewer](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html).
The `source` parameter shows callees; `sink` shows callers. Adjust `depth` in
the URL to expand or collapse.

### Encrypt / decrypt (public API)

| Function | File | Call graph | What it does |
|---|---|---|---|
| `message_encrypt` | `session_cipher.rs:19` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=message_encrypt&depth=5) | Full encrypt path: chain key → PQR send → message keys → AES-CBC → MAC → store |
| `message_decrypt` | `session_cipher.rs:162` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=message_decrypt&depth=5) | Dispatch: PreKeySignalMessage or SignalMessage |
| `message_decrypt_prekey` | `session_cipher.rs:199` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=message_decrypt_prekey&depth=5) | Decrypt PreKey message: process_prekey → decrypt_message_with_record |
| `message_decrypt_signal` | `session_cipher.rs:278` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=message_decrypt_signal&depth=5) | Decrypt regular Signal message: try sessions → decrypt |
| `decrypt_message_with_state` | `session_cipher.rs:596` | [callees (depth 4)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=decrypt_message_with_state&depth=4) | Core decrypt logic for a single session state: chain key → message key → PQR → MAC verify → AES-CBC |

### Session setup (X3DH / PQXDH)

| Function | File | Call graph | What it does |
|---|---|---|---|
| `process_prekey_bundle` | `session.rs:174` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=process_prekey_bundle&depth=5) | Alice: verify bundle signatures → initialize_alice_session → store |
| `process_prekey` | `session.rs:45` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=process_prekey&depth=5) | Bob: extract PreKey message → initialize_bob_session → promote state |
| `initialize_alice_session` | `ratchet.rs:54` | [callees (depth 4)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=initialize_alice_session&depth=4) | Alice: 4x DH + KEM encaps → derive_keys → create_chain → spqr::initial_state |
| `initialize_bob_session` | `ratchet.rs:139` | [callees (depth 4)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=initialize_bob_session&depth=4) | Bob: 4x DH + KEM decaps → derive_keys → spqr::initial_state |

### DH ratchet and chain management

| Function | File | Call graph | What it does |
|---|---|---|---|
| `get_or_create_chain_key` | `session_cipher.rs:693` | [callees (depth 4)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=get_or_create_chain_key&depth=4) | DH ratchet step: if new ephemeral, create_chain twice (recv + send), update state |
| `get_or_create_message_key` | `session_cipher.rs:729` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=get_or_create_message_key&depth=3) | Advance chain to counter, saving skipped message keys for out-of-order delivery |
| `RootKey::create_chain` | `ratchet/keys.rs:192` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=RootKey%3A%3Acreate_chain&depth=3) | DH ratchet: DH agreement + HKDF("WhisperRatchet") → new RootKey + ChainKey |
| `derive_keys` | `ratchet.rs:19` | [callees (depth 2)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=derive_keys&depth=2) | Initial key derivation: HKDF("WhisperText_...") → RootKey + ChainKey + PQR key |

### Symmetric ratchet and message keys

| Function | File | Call graph | What it does |
|---|---|---|---|
| `ChainKey::next_chain_key` | `ratchet/keys.rs:159` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=next_chain_key&depth=3) | Symmetric ratchet step: HMAC(key, 0x02) → next chain key |
| `ChainKey::message_keys` | `ratchet/keys.rs:166` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=ChainKey%3A%3Amessage_keys&depth=3) | Derive message key seed: HMAC(key, 0x01) → MessageKeyGenerator |
| `MessageKeys::derive_keys` | `ratchet/keys.rs:90` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=MessageKeys%3A%3Aderive_keys&depth=3) | HKDF("WhisperMessageKeys") → cipher_key (32B) + mac_key (32B) + iv (16B) |
| `MessageKeyGenerator::generate_keys` | `ratchet/keys.rs:22` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=generate_keys&depth=3) | Combines chain key seed with PQR key (as optional HKDF salt) to produce final MessageKeys |

### Post-quantum integration

| Function | File | Call graph | What it does |
|---|---|---|---|
| `SessionState::pq_ratchet_send` | `state/session.rs` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=pq_ratchet_send&depth=5) | Calls spqr::send() on the session's PQR state; returns (pqr_msg, pqr_key) |
| `SessionState::pq_ratchet_recv` | `state/session.rs` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=pq_ratchet_recv&depth=5) | Calls spqr::recv() on the session's PQR state; returns pqr_key |
| `spqr::initial_state` | (spqr crate) | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=spqr%3A%3Ainitial_state&depth=3) | Creates PQR state during session initialization |

### Session state management

| Function | File | Call graph | What it does |
|---|---|---|---|
| `decrypt_message_with_record` | `session_cipher.rs:422` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=decrypt_message_with_record&depth=5) | Tries current session, then previous sessions; promotes matching previous session |
| `SessionRecord::promote_matching_session` | `state/session.rs` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=promote_matching_session&depth=3) | On PreKey: checks if session already exists for this base key, promotes it |
| `SessionRecord::promote_old_session` | `state/session.rs` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=promote_old_session&depth=3) | After successful decrypt with previous session, promotes it to current |

### Recommended exploration paths

- [**message_encrypt -> aes_256_cbc_encrypt**: full encrypt path to AES](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=message_encrypt&sink=aes_256_cbc_encrypt&depth=0)
- [**message_decrypt -> aes_256_cbc_decrypt**: full decrypt path to AES](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=message_decrypt&sink=aes_256_cbc_decrypt&depth=0)
- [**initialize_alice_session -> calculate_agreement**: X3DH DH calculations](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=initialize_alice_session&sink=calculate_agreement&depth=0)
- [**message_encrypt -> spqr::send**: PQR integration in encrypt](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=message_encrypt&sink=spqr%3A%3Asend&depth=0)
- [**decrypt_message_with_state -> create_chain**: DH ratchet step in decrypt](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=decrypt_message_with_state&sink=create_chain&depth=0)
- [**process_prekey_bundle -> initialize_alice_session**: full session establishment](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=process_prekey_bundle&sink=initialize_alice_session&depth=0)

## How the Double Ratchet and SPQR interact

The classical Double Ratchet and the post-quantum ratchet run **in parallel**.
On every message:

1. The **DH ratchet** and **symmetric chain** produce a message key seed (classical security)
2. **SPQR** produces an optional message key (post-quantum security)
3. The two are combined via HKDF: the SPQR key becomes the salt for `MessageKeys::derive_keys()`

This means:
- If SPQR is disabled (V0), the classical ratchet works exactly as before
- If SPQR is active (V1), both a classical *and* a quantum attacker would need to break the protocol
- SPQR's epoch secrets are independent of the DH ratchet's ephemeral keys -- they come from ML-KEM key exchanges piggybacked on messages via chunked encoding
