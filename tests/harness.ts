// Test bootstrap. Imported at the top of every test file (Node caches the
// module, so this runs once) to:
//   1. register module-loader hooks that redirect the two pi peer imports
//      to local stubs/, so podcast.ts can load without those packages;
//   2. point HOME at a fresh temp dir so the file fallback for tokens
//      takes effect and never touches the user's real ~/.config.
//
// Run via:
//   node --test --test-isolation=none tests/*.test.ts
// (--test-isolation=none keeps all test files in the main process so the
// hooks and HOME setup actually apply to every file.)

import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stubsDir = new URL("../stubs/", import.meta.url);

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: new URL("./pi-coding-agent.mjs", stubsDir).href, shortCircuit: true };
    }
    if (specifier === "@earendil-works/pi-tui") {
      return { url: new URL("./pi-tui.mjs", stubsDir).href, shortCircuit: true };
    }
    if (specifier === "@napi-rs/keyring") {
      // Stubs that throw so the keyring path falls through to the file
      // fallback — see stubs/keyring.mjs for why this matters.
      return { url: new URL("./keyring.mjs", stubsDir).href, shortCircuit: true };
    }
    return nextResolve(specifier);
  },
});

// Sandbox HOME so the keyring file fallback path writes here.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-podcast-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;