/** Split streamed buffer chunks into complete lines, buffering any trailing partial. */
export function makeLineSplitter(emit: (line: string) => void) {
  let carry = "";
  return {
    push(chunk: Buffer | string) {
      carry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx: number;
      while ((idx = carry.indexOf("\n")) >= 0) {
        emit(carry.slice(0, idx).replace(/\r$/, ""));
        carry = carry.slice(idx + 1);
      }
    },
    flush() {
      if (carry.length > 0) {
        emit(carry.replace(/\r$/, ""));
        carry = "";
      }
    },
  };
}
