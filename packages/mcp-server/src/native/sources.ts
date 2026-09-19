import { isValidHarnessSessionId, type NativeSessionArchive } from "@session-registry/core";
import { captureNativeSession, type NativeHomes } from "./adapters.js";
import { NativeCaptureError } from "./files.js";
import type { NativeCaptureInput, NativeIdeSources } from "./sourceTypes.js";

function configured<T>(source: T | undefined, setting: string): T {
  if (source === undefined) {
    throw new NativeCaptureError("SOURCE_NOT_CONFIGURED", `Configure ${setting} for this native source before preparing a capture.`);
  }
  return source;
}

export async function captureSessionSource(
  input: NativeCaptureInput,
  homes: NativeHomes,
  ideSources: NativeIdeSources | undefined,
  maxBytes: number,
  now: () => Date = () => new Date(),
): Promise<NativeSessionArchive> {
  if (!isValidHarnessSessionId(input.harnessSessionId) ||
      (input.hostSessionId !== undefined && !isValidHarnessSessionId(input.hostSessionId))) {
    throw new NativeCaptureError("INVALID_SESSION_ID", "Use exact URL-safe native session identifiers, not paths or session URLs.");
  }
  switch (input.harness) {
    case "github-copilot-cli":
    case "claude-code":
    case "codex-cli":
      if (input.hostSessionId !== undefined) {
        throw new NativeCaptureError("UNSUPPORTED_OPTION", "hostSessionId applies only to VS Code Agent Host capture.");
      }
      return captureNativeSession(
        { harness: input.harness, harnessSessionId: input.harnessSessionId },
        homes,
        maxBytes,
        now,
      );
    case "vscode-copilot-chat": {
      const source = configured(ideSources?.vscode, "SESSION_REGISTRY_VSCODE_USER_DATA");
      const { captureVsCodeLocalSession } = await import("./vscodeLocal.js");
      return captureVsCodeLocalSession(
        input,
        source,
        maxBytes,
        now,
      );
    }
    case "vscode-copilot-agent": {
      const source = configured(ideSources?.vscode, "SESSION_REGISTRY_VSCODE_USER_DATA");
      const { captureVsCodeAgentSession } = await import("./vscodeAgentHost.js");
      return captureVsCodeAgentSession(
        input,
        source,
        homes,
        maxBytes,
        now,
      );
    }
    case "visual-studio-copilot": {
      const source = configured(ideSources?.visualStudio, "SESSION_REGISTRY_VISUAL_STUDIO_COPILOT_HOME and SESSION_REGISTRY_VISUAL_STUDIO_VERSION");
      const { captureCopilotHostSession } = await import("./copilotHosts.js");
      return captureCopilotHostSession(
        input,
        source,
        homes,
        maxBytes,
        now,
      );
    }
    case "github-copilot-desktop":
    case "github-copilot-desktop-chat": {
      const source = configured(ideSources?.desktop, "SESSION_REGISTRY_COPILOT_DESKTOP_HOME");
      const { captureCopilotHostSession } = await import("./copilotHosts.js");
      return captureCopilotHostSession(
        input,
        source,
        homes,
        maxBytes,
        now,
      );
    }
    default:
      throw new NativeCaptureError("UNSUPPORTED_HARNESS", "This harness does not have a native source adapter.");
  }
}
