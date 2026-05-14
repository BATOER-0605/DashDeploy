import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLineSplitter } from "./lines.js";

test("emits complete lines and buffers partials across chunks", () => {
  const lines: string[] = [];
  const s = makeLineSplitter((l) => lines.push(l));
  s.push("hello\nwor");
  s.push("ld\nthird");
  assert.deepEqual(lines, ["hello", "world"]);
  s.flush();
  assert.deepEqual(lines, ["hello", "world", "third"]);
});

test("strips trailing carriage returns", () => {
  const lines: string[] = [];
  const s = makeLineSplitter((l) => lines.push(l));
  s.push("a\r\nb\r\n");
  assert.deepEqual(lines, ["a", "b"]);
});

test("flush with empty carry emits nothing", () => {
  const lines: string[] = [];
  const s = makeLineSplitter((l) => lines.push(l));
  s.push("done\n");
  s.flush();
  assert.deepEqual(lines, ["done"]);
});
