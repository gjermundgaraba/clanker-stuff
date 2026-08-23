export interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

export interface ClosableCdpClient {
  close(): void;
}

export class TargetAttachmentRegistry<
  Client extends ClosableCdpClient,
  Target extends CdpTarget,
> {
  constructor(
    attach: (
      target: Target,
      isOwner: () => boolean
    ) => Client | Promise<Client>,
    onAttachError: (error: unknown, target: Target) => void
  );

  claim(target: Target): {
    claimed: boolean;
    promise: Promise<Client | undefined>;
  };

  stop(): void;
}
