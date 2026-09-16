export class NativeCaptureError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "NativeCaptureError";
  }
}
