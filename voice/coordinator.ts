import type { DelegationBinding } from "./realtime.js";

interface Handoff {
  binding: DelegationBinding;
  prompt: string;
}

interface AcceptedHandoff extends Handoff {
  deferredFailure?: string;
}

interface VoiceCoordinatorOptions {
  complete: (binding: DelegationBinding, text: string) => boolean;
  status: (binding: DelegationBinding, text: string) => boolean;
  submit: (prompt: string) => void;
  validate: () => Promise<void>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const MAX_QUEUED_HANDOFFS = 20;

export class VoiceCoordinator {
  private accepted: AcceptedHandoff | undefined;
  private generation = 0;
  private preparing = false;
  private readonly queue: Handoff[] = [];
  private readonly options: VoiceCoordinatorOptions;
  private submitted: Handoff | undefined;

  constructor(options: VoiceCoordinatorOptions) {
    this.options = options;
  }

  enqueue(handoff: Handoff): void {
    if (this.queue.length >= MAX_QUEUED_HANDOFFS) {
      this.options.complete(
        handoff.binding,
        "I could not queue that request because too many voice requests are already waiting."
      );
      return;
    }
    this.queue.push(handoff);
    void this.pump();
  }

  accept(prompt: string): boolean {
    if (this.submitted?.prompt !== prompt) {
      return false;
    }
    this.accepted = this.submitted;
    this.submitted = undefined;
    return true;
  }

  sendStatus(text: string): boolean {
    return Boolean(
      this.accepted && this.options.status(this.accepted.binding, text.trim())
    );
  }

  finish(text: string): boolean {
    const { accepted } = this;
    if (!accepted) {
      return false;
    }
    this.accepted = undefined;
    const delivered = this.options.complete(accepted.binding, text.trim());
    void this.pump();
    return delivered;
  }

  deferFailure(text: string): void {
    if (this.accepted) {
      this.accepted.deferredFailure = text.trim();
    }
  }

  settled(): void {
    if (this.accepted) {
      const { deferredFailure } = this.accepted;
      this.finish(
        deferredFailure !== undefined && deferredFailure.length > 0
          ? deferredFailure
          : "The Pi session stopped before producing a final response."
      );
      return;
    }
    if (!this.submitted) {
      return;
    }
    const { submitted } = this;
    this.submitted = undefined;
    this.options.complete(
      submitted.binding,
      "I could not submit that request to the Pi session."
    );
    void this.pump();
  }

  reset(): void {
    this.generation += 1;
    this.accepted = undefined;
    this.preparing = false;
    this.queue.length = 0;
    this.submitted = undefined;
  }

  private async pump(): Promise<void> {
    if (
      this.preparing ||
      this.submitted ||
      this.accepted ||
      this.queue.length === 0
    ) {
      return;
    }

    const handoff = this.queue.shift();
    if (!handoff) {
      return;
    }
    const { generation } = this;
    this.preparing = true;
    try {
      await this.options.validate();
      if (generation !== this.generation) {
        return;
      }
      this.submitted = handoff;
      this.options.submit(handoff.prompt);
    } catch (error) {
      if (generation === this.generation) {
        this.options.complete(
          handoff.binding,
          `I could not use the current Pi coordinator: ${errorMessage(error).slice(0, 240)}`
        );
      }
    } finally {
      if (generation === this.generation) {
        this.preparing = false;
        if (!this.submitted) {
          void this.pump();
        }
      }
    }
  }
}
