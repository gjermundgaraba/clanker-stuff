/* oxlint-disable typescript/no-misused-spread -- summaries use protocol-defined code points */

export const summary = (value: string): string =>
  [...value]
    .slice(0, 512)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
    })
    .join("");
