# Refactor before making an exception

This applies to every lint exception, not only boundary rules, and to existing exceptions when the affected code is changed.

## Procedure

1. **Identify the invariant and its owner.** Which producer or consumer owns the contract the diagnostic touches? Does the diagnostic expose a missing boundary, erased type information, duplicate validation, or an unnecessary abstraction?
2. **Consider a cleaner, more correct refactor that removes the cause**, even if it breaks an owned API. Move decoding to the real input boundary, preserve producer types, delete redundant checks, or change the contract and update all affected callers and tests. Do not add compatibility wrappers solely to preserve the old design. API stability alone is not a reason to keep avoidable debt.
3. **Preserve concrete safety requirements.** Actual persisted sessions, third-party contracts, malformed external input, and runtime compatibility are not erased by permission to break owned APIs. Establish migration or failure behavior before changing these boundaries.
4. **Distinguish rule defects from legitimate exceptions.** If behavior contradicts the rule's intended contract, follow the rule-correction workflow in [SKILL.md](../SKILL.md). Correct code intentionally caught by a broad rule instead needs the smallest justified exception; a blocked rule correction may also need one. State the concrete boundary or invariant and why the operation is still necessary, not "lint noise" or "legacy". Use a line-level disable or a tightly bounded disable/enable pair for one coherent operation; avoid file- or package-wide exclusions.
5. **Test the retained behavior or the refactor.** Unused disable directives remain errors. Temporary debt must describe what contract work would remove it; a legitimate permanent boundary need not promise a pointless future rewrite.

Fix where the untyped value was created, never at the caller. If ten consumers each probe the same raw value, the fix is one decoder at the boundary, not ten exceptions.

## Exception format

```ts
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript may throw any value.
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

```ts
/* oxlint-disable anti-slop/no-runtime-typeof -- Complete handwritten validation of the external manifest, including exact keys and nonempty fields; no schema dependency is installed in this container. */
function isManifest(value: unknown): value is Manifest {
  ...
}
/* oxlint-enable anti-slop/no-runtime-typeof */
```

The reason names the boundary (external JSON, thrown value, pinned SDK declaration, deliberately malformed fixture, already-typed union discrimination) and what the operation still guarantees. A reason that only restates the rule name or says the code is old is not a reason.

## Laundering: changes that silence lint without adding safety

Each of these makes the diagnostic disappear while leaving the code exactly as unsafe. Treat them as new defects, not fixes.

| Laundering move | Why it fails |
| --- | --- |
| Renaming a parameter to an exempt spelling such as `cause` | Names do not grant exceptions; the value is still unknown. |
| Removing a type annotation so inference produces `any` | Trades a visible unknown for an invisible one. |
| Substituting `any`, or an unconstrained `<T>` generic | Removes the check entirely. |
| Casting (`as User`) or chaining assertions | Asserts what was supposed to be proven. |
| Moving the same `typeof` into a one-use `isString` helper | Claims the type-guard exemption without validating anything new. |
| Replacing `typeof x === "string"` with `Value.Check(Type.String(), x)` | A primitive schema is the same check in a different spelling. |
| `flatMap(x => cond ? [x] : [])` to avoid adjacent filter/map | Same work, less readable, and changes nothing about performance. |
| Re-declaring a schema for data the same module already owns and typed | Duplicate validation, with two contracts that can drift. |
| Constructing `{}` then assigning properties to evade widening checks | The evidence loss the rule flags is still there. |
| Adding `@ts-expect-error` without stating the precise mismatch | Hides a real conflict instead of documenting it. |
| Moving code to a `.js` or `.mjs` file outside enforcement | Escapes the policy rather than meeting it. |
| A `SAFETY` comment with no evidence the compiler or runtime provides | A comment does not prove an invariant. |
| Changing `vi.mock` to `vi.spyOn` on the same import | Not an architectural change; the coupling is unchanged. |
| A file- or package-wide `overrides` entry to hide a backlog | Converts findings into permanent invisible debt. |

## Distinguish debt from legitimate boundaries

- **Permanent legitimate boundary:** arbitrary thrown values, an arbitrary-value serializer or diagnostic printer, a foreign protocol adapter, a runtime or version adapter, a pinned SDK declaration conflict, a deliberately malformed test fixture, a benchmark task's deliberate defect. Take the narrow exception and explain it. No future rewrite promise is needed.
- **Temporary migration debt:** a whole provider excluded from a rule, tests exempted as a group, a rule left off because the backlog was large. Record what contract work removes it; do not present it as policy.

Existing exceptions are evidence about the code, not precedent for new ones.
