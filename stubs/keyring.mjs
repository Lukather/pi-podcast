// Configurable stub for @napi-rs/keyring. The mode is read from
// PI_PODCAST_KEYRING_STUB on every call, so tests can flip it
// before each scenario.
//
// Modes:
//   "missing" (default): Entry constructor throws. Simulates the
//                        keyring being unusable — keyringAvailable()
//                        returns true (the import succeeds) but every
//                        construction fails. The fix is supposed to
//                        catch this and fall back to the file path.
//   "broken":            Entry constructor succeeds, methods throw.
//                        Simulates a locked credential store on
//                        @napi-rs/keyring 2.x — the import succeeds
//                        and the operations throw. Same fix applies.

function getMode() {
  return process.env.PI_PODCAST_KEYRING_STUB ?? "missing";
}

function modeErr(op) {
  const m = getMode();
  if (m === "missing") return new Error(`@napi-rs/keyring unavailable in tests (${op})`);
  if (m === "broken") return new Error(`keyring ${op} failed in tests`);
  throw new Error(`unknown PI_PODCAST_KEYRING_STUB mode: ${m}`);
}

export class Entry {
  constructor(service, account) {
    if (getMode() === "missing") throw modeErr("constructor");
    this.service = service;
    this.account = account;
  }
  getPassword() {
    if (getMode() === "broken") throw modeErr("getPassword");
    return null;
  }
  setPassword(_password) {
    if (getMode() === "broken") throw modeErr("setPassword");
  }
  deletePassword() {
    if (getMode() === "broken") throw modeErr("deletePassword");
  }
}
