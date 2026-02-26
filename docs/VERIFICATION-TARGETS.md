# Potential Low-Hanging Fruits for Signal Formal Verification

This document identifies areas of the libsignal codebase that could benefit from
formal verification efforts and are relatively accessible compared to the complex
protocol-level verification already conducted (e.g., the Verus verification of
`curve25519-dalek` field arithmetic). Each section connects the verification target
to specific crates, modules, and files in the workspace.

For crate descriptions and dependency relationships, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Local Storage Encryption

Signal's backup encryption and key derivation pipelines are prime verification
targets because they involve standard cryptographic patterns with clearly defined
correctness properties.

### What to verify

- The key derivation chain is correct: `AccountEntropyPool` -> `BackupKey` -> `BackupId` -> (HMAC key, AES key)
- AES-256-CBC encryption/decryption with PKCS7 padding preserves plaintext integrity
- HMAC verification cannot be bypassed or reordered relative to decryption
- PIN hashing (Argon2id for SVR, Argon2i for local) uses correct parameters

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **libsignal-account-keys** | `rust/account-keys/src/backup.rs` | Key hierarchy: `BackupKey`, `BackupId`, `BackupForwardSecrecyToken`; HKDF-based derivation for backup ID, media keys, and forward-secrecy tokens |
| **libsignal-account-keys** | `rust/account-keys/src/lib.rs` | `AccountEntropyPool` (64-char entropy source); `derive_svr_key()` via HKDF |
| **libsignal-account-keys** | `rust/account-keys/src/hash.rs` | `PinHash`, `local_pin_hash()`, `verify_local_pin_hash()` -- Argon2 PIN stretching |
| **libsignal-message-backup** | `rust/message-backup/src/key.rs` | `MessageBackupKey::derive()` -- derives HMAC and AES keys from `BackupKey` + `BackupId` via HKDF-SHA256 |
| **libsignal-message-backup** | `rust/message-backup/src/frame.rs` | `FramesReader` -- reads encrypted backup frames with HMAC-then-decrypt ordering |
| **libsignal-message-backup** | `rust/message-backup/src/frame/aes_read.rs` | `Aes256CbcReader` -- streaming AES-256-CBC decryption with PKCS7 unpadding |
| **signal-crypto** | `rust/crypto/src/aes_cbc.rs` | `aes_256_cbc_encrypt()`, `aes_256_cbc_decrypt()` -- the underlying AES-CBC primitives |
| **signal-crypto** | `rust/crypto/src/aes_gcm.rs` | `Aes256GcmEncryption`, `Aes256GcmDecryption` -- AEAD used elsewhere in the stack |

### Why it's tractable

The key derivation chain is a pure function pipeline (entropy -> HKDF -> keys) with
no protocol state. The encryption is standard AES-CBC + HMAC-SHA256. Both are amenable
to symbolic verification or property-based testing against reference implementations.

---

## 2. Cross-Platform Implementation Consistency

libsignal uses a single Rust core with platform bridges for Swift, Java, and Node.js.
The bridge layer is where platform-specific divergence can occur.

### What to verify

- All three bridges expose the same set of security-critical operations
- Type conversions across the bridge boundary preserve invariants (e.g., key lengths, nonce uniqueness)
- Error handling is consistent: no bridge silently swallows a crypto failure that another surfaces

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **libsignal-bridge** (non-member) | `rust/bridge/shared/src/protocol.rs` | `HKDF_DeriveSecrets`, session/ratchet/PreKey/SealedSender handles |
| **libsignal-bridge** (non-member) | `rust/bridge/shared/src/crypto.rs` | `Aes256Ctr32_*`, `Aes256GcmEncryption_*`, `Aes256GcmDecryption_*` |
| **libsignal-bridge** (non-member) | `rust/bridge/shared/src/account_keys.rs` | `AccountEntropyPool_*`, `BackupKey_Derive*`, `PinHash_*` |
| **libsignal-bridge-types** (non-member) | `rust/bridge/shared/types/src/` | Type conversion traits for FFI/JNI/Neon -- where invariants could be violated |
| **libsignal-ffi** | `rust/bridge/ffi/src/lib.rs` | C ABI entry points for Swift |
| **libsignal-jni-impl** | `rust/bridge/jni/impl/src/lib.rs` | JNI `Java_*` entry points for Android |
| **libsignal-node** | `rust/bridge/node/src/lib.rs` | Neon entry points for TypeScript |

### Why it's tractable

The `#[bridge_fn]` macro system generates per-platform wrappers from a single
definition. Verification could focus on the macro expansion itself -- proving that
the generated FFI/JNI/Neon wrappers faithfully forward arguments and return values
without introducing platform-specific divergence. The bridge shared crate
(`rust/bridge/shared/`) is the single source of truth.

---

## 3. UI Security Properties

UI security properties live mostly in the client apps (Swift/Java/TypeScript), not
in libsignal itself. However, the Rust codebase defines the **data** that drives
security-critical UI decisions.

### What to verify

- Safety number (fingerprint) computation is deterministic and collision-resistant
- Identity key change detection correctly triggers UI warnings
- Sealed sender status is correctly propagated to callers

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **libsignal-protocol** | `rust/protocol/src/fingerprint.rs` (via `pub use`) | Safety number / fingerprint computation from identity keys |
| **libsignal-protocol** | `rust/protocol/src/identity_key.rs` (via `pub use`) | `IdentityKey`, `IdentityKeyPair` -- the keys that drive trust decisions |
| **libsignal-protocol** | `rust/protocol/src/sealed_sender.rs` (via `pub use`) | Sealed sender encrypt/decrypt -- determines whether sender identity is revealed |
| **libsignal-bridge** (non-member) | `rust/bridge/shared/src/protocol.rs` | Bridge functions that expose fingerprint and identity operations to platforms |

### Why it's tractable

Fingerprint computation is a pure function (two identity keys + two identifiers -> display string).
Verifying its collision resistance and determinism is a bounded problem. Identity key
change detection reduces to checking equality of public key bytes across sessions.

---

## 4. Session Reset Mechanisms

When cryptographic state becomes corrupted or out-of-sync, Signal's session reset
mechanism must recover without introducing vulnerabilities.

### What to verify

- Session archiving preserves the ability to decrypt in-flight messages from the old session
- Session promotion (when a new PreKey message arrives) correctly replaces stale state
- Ratchet forward-jump limits (`MAX_FORWARD_JUMPS`) are enforced and cannot be bypassed
- Staleness detection (`MAX_UNACKNOWLEDGED_SESSION_AGE`) correctly expires sessions

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **libsignal-protocol** | `rust/protocol/src/state/session.rs` | `SessionRecord`, `SessionState`, `archive_current_state_inner()`, `promote_matching_session()` -- session lifecycle |
| **libsignal-protocol** | `rust/protocol/src/session.rs` | `process_prekey()` -- establishes new sessions from PreKey messages, handles X3DH/PQXDH |
| **libsignal-protocol** | `rust/protocol/src/session_cipher.rs` | `message_encrypt()`, `message_decrypt()` -- manages active/archived session selection |
| **libsignal-protocol** | `rust/protocol/src/ratchet.rs` | `initialize_alice_session()`, `initialize_bob_session()` -- Double Ratchet setup |
| **libsignal-protocol** | `rust/protocol/src/ratchet/keys.rs` | `ChainKey`, `RootKey`, `MessageKeyGenerator` -- key evolution logic |
| **libsignal-protocol** | `rust/protocol/src/consts.rs` | `MAX_FORWARD_JUMPS`, `MAX_UNACKNOWLEDGED_SESSION_AGE` -- safety bounds |

### Why it's tractable

Session reset is a finite state machine: current session, archived sessions, and
transitions triggered by incoming PreKey messages or staleness timeouts. The state
space is bounded by `MAX_FORWARD_JUMPS` (2000) and the number of archived sessions.
This is well-suited to model checking or bounded verification.

---

## 5. Registration and Device Linking

The registration and device linking flow is a discrete, sequential process with
clearly defined security goals.

### What to verify

- Registration sessions cannot be replayed or hijacked
- Device transfer certificates authenticate the source device
- SVR2 credential checks during registration are correctly gated

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **libsignal-net-chat** | `rust/net/chat/src/registration.rs` | `RegistrationService` -- high-level registration client, session create/resume |
| **libsignal-net-chat** | `rust/net/chat/src/api/registration.rs` | `RegistrationChatApi`, `CreateSession`, `RegisterAccountResponse`, `check_svr2_credentials()` |
| **libsignal-net-chat** | `rust/net/chat/src/ws/registration.rs` | WebSocket-based registration transport |
| **device-transfer** | `rust/device-transfer/src/lib.rs` | `create_rsa_private_key()`, `create_self_signed_cert()` -- RSA key + X.509 cert for device migration |

### Why it's tractable

Registration is a request-response protocol with a small number of states (no session,
pending verification, verified). Device transfer is even simpler: one RSA keypair
generation + one self-signed certificate. Standard authentication protocol verification
techniques (e.g., ProVerif, Tamarin) apply directly.

---

## 6. Model-Based Test Generation

Formal models of the Signal Protocol already exist. Deriving concrete test cases from
them would bridge the gap between verified models and the Rust implementation.

### What to verify

- Edge cases from protocol models (e.g., simultaneous key exchange, ratchet desync)
  are covered by tests
- Message ordering invariants hold under adversarial reordering
- Boundary conditions on ratchet jumps and session counts

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **libsignal-protocol** | `rust/protocol/src/session_cipher.rs` | Encrypt/decrypt -- the primary target for model-derived tests |
| **libsignal-protocol** | `rust/protocol/src/group_cipher.rs` | Group encrypt/decrypt -- sender key distribution edge cases |
| **libsignal-protocol** | `rust/protocol/src/ratchet.rs` | Ratchet initialization -- simultaneous setup scenarios |
| **libsignal-protocol** | `rust/protocol/src/storage/inmem.rs` | `InMemSessionStore` -- in-memory store used by existing tests, easily extended |

### Why it's tractable

The existing test infrastructure in `libsignal-protocol` already uses `InMemSessionStore`
and exercises multi-step protocol flows. Adding model-derived test cases requires no
new infrastructure -- only new test functions targeting specific state sequences.

---

## 7. Group Membership Consistency

Signal's group messaging relies on sender keys distributed to group members, plus
zero-knowledge credentials for anonymous group operations.

### What to verify

- Sender key distribution reaches all group members before encrypted messages are sent
- Group state (membership list, access control) stays consistent across concurrent updates
- Zero-knowledge group send endorsements cannot be forged or replayed

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **libsignal-protocol** | `rust/protocol/src/group_cipher.rs` | `group_encrypt()`, `group_decrypt()` -- sender-key-based group encryption |
| **libsignal-protocol** | `rust/protocol/src/sender_keys.rs` | `SenderKeyState`, `SenderKeyRecord`, `SenderChainKey` -- sender key lifecycle and chain key evolution |
| **zkgroup** | `rust/zkgroup/src/api/groups.rs` | `GroupMasterKey`, `GroupPublicParams`, `GroupSecretParams` -- group credential parameters |
| **zkgroup** | `rust/zkgroup/src/api/groups/group_send_endorsement.rs` | `GroupSendEndorsement`, `GroupSendToken` -- authorization tokens for group sends |
| **zkcredential** | `rust/zkcredential/src/endorsements.rs` | Endorsement issuance and verification framework |

### Why it's tractable

Group membership is a set with add/remove operations and well-defined consistency
properties (every member has the current sender key, no non-member can decrypt).
The sender key mechanism in `libsignal-protocol` is simpler than the 1:1 Double
Ratchet -- it's a single symmetric ratchet per sender. The zkgroup credentials
are algebraic and amenable to symbolic verification.

---

## 8. Secure Enclave Integration

Signal uses hardware enclaves (SGX, Nitro) for Contact Discovery (CDSI) and Secure
Value Recovery (SVR). The attestation and connection establishment is a critical
trust boundary.

### What to verify

- Attestation evidence parsing rejects malformed or expired quotes
- The Noise NK handshake binds the attested enclave identity to the transport session
- CDSI lookups cannot leak contact information outside the enclave
- SVR rate-limiting cannot be bypassed through session manipulation

### Crates and files

| Crate | File | What it does |
|---|---|---|
| **attest** | `rust/attest/src/enclave.rs` | `Handshake` -- builds Noise NK handshake from attestation evidence; supports pre- and post-quantum |
| **attest** | `rust/attest/src/dcap/evidence.rs` | `Evidence`, `SgxQuote`, `CustomClaims` -- DCAP attestation evidence parsing |
| **attest** | `rust/attest/src/dcap/sgx_quote.rs` | SGX quote structure parsing and validation |
| **attest** | `rust/attest/src/cds2.rs` | `new_handshake()` -- CDSI-specific attestation handshake |
| **attest** | `rust/attest/src/svr2.rs` | `new_handshake()`, `RaftConfig` -- SVR2 attestation with Raft group validation |
| **attest** | `rust/attest/src/hsm_enclave.rs` | `ClientConnectionEstablishment`, `ClientConnection` -- HSM enclave Noise handshake |
| **libsignal-net** | `rust/net/src/enclave.rs` | `EnclaveKind`, `Cdsi`, `SvrSgx` -- enclave connection types and endpoint routing |
| **libsignal-net** | `rust/net/src/cdsi.rs` | `LookupRequest`, `AciAndAccessKey` -- CDSI lookup protocol |
| **libsignal-net** | `rust/net/src/svr.rs` | `SvrConnection<Kind>` -- attested WebSocket connection to SVR |

### Why it's tractable

Attestation is a verification pipeline: parse evidence -> check signatures -> extract
enclave identity -> bind to Noise handshake. Each stage has clear preconditions and
postconditions. The `attest` crate is self-contained (no workspace dependencies),
making it an ideal isolated verification target.

---

## Summary: crate coverage

| Verification target | Primary crates |
|---|---|
| Local storage encryption | libsignal-account-keys, libsignal-message-backup, signal-crypto |
| Cross-platform consistency | libsignal-bridge (non-member), libsignal-ffi, libsignal-jni-impl, libsignal-node |
| UI security properties | libsignal-protocol (fingerprint, identity, sealed sender) |
| Session reset mechanisms | libsignal-protocol (session, ratchet, session_cipher) |
| Registration and device linking | libsignal-net-chat, device-transfer |
| Model-based test generation | libsignal-protocol (tests and in-memory stores) |
| Group membership consistency | libsignal-protocol (group_cipher, sender_keys), zkgroup, zkcredential |
| Secure enclave integration | attest, libsignal-net |
