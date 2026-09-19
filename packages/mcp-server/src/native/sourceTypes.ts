import type { NativeHarness } from "@session-registry/core";

export interface NativeCaptureInput {
  readonly harness: NativeHarness;
  readonly harnessSessionId: string;
  readonly hostSessionId?: string;
}

export interface VsCodeCaptureSource {
  readonly userDataPath: string;
  readonly copilotHome: string;
}

export interface CopilotHostCaptureSource {
  readonly copilotHome: string;
  readonly hostVersion?: string;
}

export interface NativeIdeSources {
  readonly vscode?: VsCodeCaptureSource;
  readonly visualStudio?: CopilotHostCaptureSource;
  readonly desktop?: CopilotHostCaptureSource;
}
