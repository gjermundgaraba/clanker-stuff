import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const WireValueSchema = Type.Unknown();
export type WireValue = Static<typeof WireValueSchema>;

export const WireRecordSchema = Type.Record(Type.String(), Type.Unknown());
export type WireRecord = Static<typeof WireRecordSchema>;

export const StringValueSchema = Type.String();
export const NumberValueSchema = Type.Number();
export const FunctionValueSchema = Type.Function([], Type.Unknown());

export const isWireRecord = (value: WireValue): value is WireRecord =>
  Value.Check(WireRecordSchema, value);
