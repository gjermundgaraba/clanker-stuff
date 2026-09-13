import type { Model, Usage } from "@earendil-works/pi-ai";

export interface SamplingStatus {
  limitReached: boolean;
  usageComplete: boolean;
  usage?: Usage;
}

export interface SamplingScope {
  boundText(text: string): string;
  run<T>(callback: () => T): T;
  dispose(): Promise<void>;
  readonly status: Readonly<SamplingStatus>;
}

/** The scope must belong to the runtime implementing the selected registry provider. */
export interface SamplingScopeRequest {
  model: Model<string>;
  maxTokens: number;
  resolve(scope: Promise<SamplingScope>): void;
}

export interface SamplingEvents {
  "clanker-codex:sampling-scope-request": SamplingScopeRequest;
}
