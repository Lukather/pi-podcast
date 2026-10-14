// Temporary failing test to verify CI surfaces red on a deliberate failure.
// Delete after #11 acceptance is verified.
import { test } from "node:test";
import assert from "node:assert/strict";

test("red-check: this test is supposed to fail", () => {
  assert.equal(1, 2, "deliberate failure to verify CI shows red");
});