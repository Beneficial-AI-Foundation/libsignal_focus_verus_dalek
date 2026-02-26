# SPQR: Implementation Guide

SPQR (Sparse Post-Quantum Ratchet) implements Signal's post-quantum ratchet
protocol. It outputs **message keys** that a messaging protocol (like Signal's
Double Ratchet) mixes in to achieve post-quantum Forward Secrecy (FS) and Post
Compromise Security (PCS).

All source lives in `deps/spqr/src/`.

## Module map

```
lib.rs                          Public API: initial_state(), send(), recv()
├── v1/                         ML-KEM Braid Protocol (V1)
│   ├── unchunked/
│   │   ├── send_ek.rs          Alice-side state machine (keygen side)
│   │   └── send_ct.rs          Bob-side state machine (encapsulation side)
│   └── chunked/
│       ├── states.rs           Unified state enum wrapping both sides
│       ├── send_ek.rs          Chunked Alice-side (adds erasure coding)
│       └── send_ct.rs          Chunked Bob-side (adds erasure coding)
├── chain.rs                    Symmetric ratchet: epoch secrets -> message keys
├── incremental_mlkem768.rs     Split ML-KEM 768: generate, encaps1, encaps2, decaps
├── authenticator.rs            HMAC-based authentication of headers and ciphertexts
├── kdf.rs                      HKDF-SHA256 wrappers
├── encoding/
│   ├── polynomial.rs           Reed-Solomon erasure coding (PolyEncoder/PolyDecoder)
│   ├── gf.rs                   GF(2^16) finite field arithmetic
│   └── round_robin.rs          Alternative round-robin encoding
└── serialize.rs                Protobuf serialization helpers
```

## Architecture overview

SPQR has three layers, each delegating to the one below:

```
┌─────────────────────────────────────────────────────────────────┐
│ lib.rs  —  Public API                                           │
│   send() / recv() / initial_state()                             │
│   Manages version negotiation, serialization, and the Chain.    │
│   Calls into V1 chunked states and Chain.                       │
├─────────────────────────────────────────────────────────────────┤
│ v1/chunked/states.rs  —  Unified V1 state machine               │
│   States enum (11 variants) dispatches send/recv.               │
│   Wraps unchunked states + polynomial erasure encoders/decoders │
│   to fragment large KEM values into 34-byte chunks.             │
├─────────────────────────────────────────────────────────────────┤
│ v1/unchunked/  —  Core braid protocol                           │
│   send_ek.rs (Alice):  KeysUnsampled → HeaderSent → EkSent     │
│                         → EkSentCt1Received → (back to start)   │
│   send_ct.rs (Bob):    NoHeaderReceived → HeaderReceived        │
│                         → Ct1Sent → Ct1SentEkReceived           │
│                         → Ct2Sent → (back to start)             │
│   Uses incremental_mlkem768 for KEM and authenticator for MACs. │
└─────────────────────────────────────────────────────────────────┘
```

## The ML-KEM Braid Protocol (V1)

Each **epoch** produces one shared secret. Two parties (Alice = `send_ek`,
Bob = `send_ct`) run complementary state machines that interleave ML-KEM
operations across messages. After completing an epoch, the roles swap:
Alice becomes Bob and vice versa.

### Alice (send_ek) state machine

```
KeysUnsampled ──send_header()──► HeaderSent ──send_ek()──► EkSent
                                                              │
                    ┌─────────recv_ct2()──── EkSentCt1Received│
                    │         (emits EpochSecret,             │
                    │          epoch += 1,                    │recv_ct1()
                    ▼          becomes Bob)                   │
             KeysUnsampled ◄──────────────────────────────────┘
             (next epoch,
              now as Bob)
```

### Bob (send_ct) state machine

```
NoHeaderReceived ──recv_header()──► HeaderReceived ──send_ct1()──► Ct1Sent
                                                                      │
                       ┌──recv_next_epoch()── Ct2Sent                 │
                       │   (epoch += 1,          ▲                    │recv_ek()
                       │    becomes Alice)        │send_ct2()         │
                       ▼                     Ct1SentEkReceived ◄──────┘
                KeysUnsampled
                (next epoch,
                 now as Alice)
```

### What flows between the parties in one epoch

```
Alice                                        Bob
  │                                            │
  ├──── Hdr (ML-KEM pk1, 64B) + MAC ────────►│  recv_header()
  │                                            │
  │◄──── CT1 (ML-KEM ciphertext1, 960B) ─────┤  send_ct1()
  │                                      emits EpochSecret (Bob side)
  │                                            │
  ├──── EK (ML-KEM pk2, 1152B) ─────────────►│  recv_ek()
  │                                            │
  │◄──── CT2 (ML-KEM ciphertext2, 128B) + MAC┤  send_ct2()
  │  recv_ct2()                                │
  │  emits EpochSecret (Alice side)            │
  │                                            │
  │  ─── roles swap, epoch increments ───      │
```

The "incremental" in incremental ML-KEM 768 means the KEM is split: `generate()`
produces (pk1=Hdr, pk2=EK, dk). Encapsulation is two steps: `encaps1(Hdr)` ->
(CT1, state, secret) then `encaps2(EK, state)` -> CT2. Decapsulation is
`decaps(dk, CT1, CT2)` -> secret. This lets the two halves of the public key
and ciphertext travel in separate messages.

## The Chain (symmetric ratchet)

Each epoch's shared secret is fed into `Chain::add_epoch()`, which uses
HKDF-SHA256 to derive per-direction (send/recv) key chains. The chain then
generates per-message keys via `send_key()` / `recv_key()`.

```
initial_key ──HKDF──► root_key[0], send_chain[0], recv_chain[0]
                          │
epoch_secret[1] ──HKDF──► root_key[1], send_chain[1], recv_chain[1]
                          │
epoch_secret[2] ──HKDF──► root_key[2], send_chain[2], recv_chain[2]
                         ...
```

Each chain direction ratchets forward with HKDF to produce sequential message
keys. Old keys are kept in a `KeyHistory` for out-of-order message decryption
(up to `max_ooo_keys`, default 2000). Keys too far ahead are rejected
(`max_jump`, default 25000).

## Chunked encoding

ML-KEM values (64B-1152B) are too large to piggyback on every Signal message.
SPQR uses Reed-Solomon systematic erasure codes (`encoding/polynomial.rs`) to
split them into 34-byte chunks (2B index + 32B data). For an N-chunk message,
**any** N received chunks suffice for reconstruction. This tolerates lost or
reordered messages gracefully.

## Key functions for call graphs

These are the functions whose call graphs would best illustrate SPQR's
implementation. They are listed in order from highest-level entry points
down to the core cryptographic primitives.

Call graph links point to the [SCIP Call Graph Viewer](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html)
deployed for this repo. The `source` parameter shows callees (what the function
calls); `sink` shows callers (who calls it). Adjust the `depth` parameter in the
URL to expand or collapse the graph.

### Top-level API (the functions libsignal-protocol calls)

| Function | File | Call graph | What it does |
|---|---|---|---|
| `spqr::initial_state` | `lib.rs:196` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=initial_state&depth=3) | Creates initial PQ ratchet state for a session; initializes V1 states and version negotiation |
| `spqr::send` | `lib.rs:249` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=spqr%3A%3Asend&depth=5) | Advances the ratchet on send: runs V1 state machine, feeds epoch secret into Chain, returns message key |
| `spqr::recv` | `lib.rs:340` | [callees (depth 5)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=spqr%3A%3Arecv&depth=5) | Advances the ratchet on recv: version negotiation, V1 state machine, Chain key derivation |

### V1 state machine (chunked layer)

| Function | File | Call graph | What it does |
|---|---|---|---|
| `States::send` | `v1/chunked/states.rs:115` | [callees (depth 4)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=states%3A%3AStates%3A%3Asend&depth=4) | 11-way match dispatching send for the current state; emits a chunk + optional EpochSecret |
| `States::recv` | `v1/chunked/states.rs:264` | [callees (depth 4)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=states%3A%3AStates%3A%3Arecv&depth=4) | 11-way match dispatching recv; processes incoming chunk, transitions state |

### V1 core protocol (unchunked layer -- where the crypto happens)

| Function | File | Call graph | What it does |
|---|---|---|---|
| `KeysUnsampled::send_header` | `v1/unchunked/send_ek.rs:82` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=KeysUnsampled%3A%3Asend_header&depth=3) | Alice: generates ML-KEM keypair, MACs the header, transitions to HeaderSent |
| `EkSentCt1Received::recv_ct2` | `v1/unchunked/send_ek.rs:135` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=EkSentCt1Received%3A%3Arecv_ct2&depth=3) | Alice: decapsulates (dk, CT1, CT2) -> shared secret, verifies MAC, completes epoch |
| `NoHeaderReceived::recv_header` | `v1/unchunked/send_ct.rs:100` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=NoHeaderReceived%3A%3Arecv_header&depth=3) | Bob: verifies header MAC, stores header for later encapsulation |
| `HeaderReceived::send_ct1` | `v1/unchunked/send_ct.rs:119` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=HeaderReceived%3A%3Asend_ct1&depth=3) | Bob: runs encaps1(Hdr) -> (CT1, state, secret), derives epoch key, updates authenticator |
| `Ct1Sent::recv_ek` | `v1/unchunked/send_ct.rs:153` | [callees (depth 2)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=Ct1Sent%3A%3Arecv_ek&depth=2) | Bob: receives and validates encapsulation key (pk2 matches pk1) |
| `Ct1SentEkReceived::send_ct2` | `v1/unchunked/send_ct.rs:176` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=Ct1SentEkReceived%3A%3Asend_ct2&depth=3) | Bob: runs encaps2(EK, state) -> CT2, MACs (CT1||CT2), completes epoch |

### Symmetric chain

| Function | File | Call graph | What it does |
|---|---|---|---|
| `Chain::new` | `chain.rs:305` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=Chain%3A%3Anew&depth=3) | Creates chain from initial key via HKDF; derives root + per-direction chain keys |
| `Chain::add_epoch` | `chain.rs:327` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=Chain%3A%3Aadd_epoch&depth=3) | Mixes epoch secret into chain via HKDF; creates new send/recv key chains |
| `Chain::send_key` | `chain.rs:357` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=Chain%3A%3Asend_key&depth=3) | Returns next message key for a given epoch's send direction |
| `Chain::recv_key` | `chain.rs:376` | [callees (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=Chain%3A%3Arecv_key&depth=3) | Returns message key at a specific index for recv direction (supports out-of-order) |

### Cryptographic primitives

| Function | File | Call graph | What it does |
|---|---|---|---|
| `incremental_mlkem768::generate` | `incremental_mlkem768.rs:34` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=incremental_mlkem768%3A%3Agenerate&depth=3) | ML-KEM 768 keypair generation: (pk1=Header 64B, pk2=EK 1152B, dk 2400B) |
| `incremental_mlkem768::encaps1` | `incremental_mlkem768.rs:48` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=incremental_mlkem768%3A%3Aencaps1&depth=3) | First encapsulation step: Hdr -> (CT1 960B, state 2080B, secret 32B) |
| `incremental_mlkem768::encaps2` | `incremental_mlkem768.rs:71` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=incremental_mlkem768%3A%3Aencaps2&depth=3) | Second encapsulation step: (EK, state) -> CT2 128B |
| `incremental_mlkem768::decaps` | `incremental_mlkem768.rs:82` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=incremental_mlkem768%3A%3Adecaps&depth=3) | Decapsulation: (dk, CT1, CT2) -> secret 32B |
| `Authenticator::update` | `authenticator.rs:44` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=Authenticator%3A%3Aupdate&depth=3) | Evolves authenticator root + MAC keys via HKDF with epoch secret |
| `Authenticator::mac_hdr` | `authenticator.rs:91` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=Authenticator%3A%3Amac_hdr&depth=3) | HMAC-SHA256 over header for authenticity |
| `Authenticator::verify_ct` | `authenticator.rs:57` | [callers (depth 3)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=Authenticator%3A%3Averify_ct&depth=3) | Verifies HMAC over ciphertext (CT1||CT2) |
| `kdf::hkdf_to_slice` | `kdf.rs:18` | [callers (depth 2)](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?sink=hkdf_to_slice&depth=2) | HKDF-SHA256 expand (uses hkdf crate or libcrux depending on build) |

### Recommended exploration paths

These source-to-sink views show how data flows between specific pairs of functions:

- [**send -> decaps**: full send path to ML-KEM decapsulation](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=spqr%3A%3Asend&sink=decaps&depth=0)
- [**recv -> encaps1**: full recv path to ML-KEM first encapsulation](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=spqr%3A%3Arecv&sink=encaps1&depth=0)
- [**send -> hkdf_to_slice**: all HKDF derivations triggered by send](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=spqr%3A%3Asend&sink=hkdf_to_slice&depth=0)
- [**recv -> verify_ct**: recv path to ciphertext MAC verification](https://beneficial-ai-foundation.github.io/libsignal_focus_verus_dalek/index.html?source=spqr%3A%3Arecv&sink=verify_ct&depth=0)

## Integration with libsignal-protocol

`libsignal-protocol` calls SPQR through three functions in its ratchet:

```
rust/protocol/src/ratchet.rs
  │
  ├── spqr::initial_state()   — called during session setup (X3DH/PQXDH)
  ├── spqr::send()            — called before each message_encrypt()
  └── spqr::recv()            — called during each message_decrypt()
```

The `MessageKey` returned by `send()` / `recv()` is mixed into the Double
Ratchet's symmetric chain, giving the session post-quantum security without
replacing the classical DH ratchet.

## Formal verification status

SPQR uses two verification approaches:
- **hax + F\***: Extracts Rust to F\* and proves panic-freedom. Functions marked
  `#[hax_lib::fstar::verification_status(lax)]` are not yet fully verified.
  Most unchunked protocol functions have `hax_lib` preconditions/postconditions
  on buffer sizes.
- **ProVerif**: Handwritten models in the repo prove security properties
  (forward secrecy, post-compromise security) of the braid protocol and
  symmetric chain.
