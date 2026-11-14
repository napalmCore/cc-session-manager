/**
 * Characters a name or folder must not contain (NFR-14, 0025): C0 and C1 control characters,
 * delete, line and paragraph separators, the soft hyphen, and the invisible formatting and
 * direction marks that could make text look like something else, such as right-to-left
 * overrides. Zero-width joiners stay allowed, because ordinary text, such as Persian names and
 * some emoji, needs them.
 */
function isUnsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x00ad ||
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Whether text has a C0 or C1 control character or delete, other than any in `allowed`. For a
 * prompt, which goes straight to Claude Code and is never shown, so formatting marks pasted
 * from a web page are fine.
 */
export function hasRawControl(text: string, allowed = ""): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (control && !allowed.includes(ch)) return true;
  }
  return false;
}

/** Whether text has an unsafe character, other than any in `allowed`. */
export function hasControl(text: string, allowed = ""): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isUnsafe(code) && !allowed.includes(ch)) return true;
  }
  return false;
}
