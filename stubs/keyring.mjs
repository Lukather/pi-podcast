// Always throws on import so the extension's keyring path falls through to
// the file fallback. Critical for tests: without this stub, a developer's
// real Pocket Casts tokens in Windows Credential Manager / macOS Keychain
// would load into the test process and break the free-path tests (and
// worse, leak session activity back to the developer's account).

// Top-level throw makes module evaluation reject; the surrounding
// try/catch in podcast.ts catches and treats the keyring as unavailable.
throw new Error("@napi-rs/keyring stubbed out in tests");