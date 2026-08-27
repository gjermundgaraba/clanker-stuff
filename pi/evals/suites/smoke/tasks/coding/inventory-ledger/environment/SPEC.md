# Inventory ledger

Implement the exports in `src/ledger.js`.

- `parseEvents` reads newline-delimited JSON, ignoring blank lines and comments whose first non-space character is `#`.
- Malformed JSON throws `SyntaxError` with a message beginning `line N:` (physical line number).
- Events are objects with type `receive`, `ship`, or `adjust`; a non-empty SKU normalized with `trim().toUpperCase()`; and an integer quantity. Receive/ship quantities are positive; adjust is non-negative.
- `applyEvents` returns a `Map`. Receive adds, ship subtracts, and adjust replaces. Shipping below zero throws `RangeError` mentioning the SKU and source line.
