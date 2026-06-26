export class SuperRareConnectApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(`API error ${status} on ${path}: ${message}`);
    this.name = 'SuperRareConnectApiError';
    this.status = status;
    this.path = path;
  }
}
