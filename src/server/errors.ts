/** Configuration error that names a variable or setting, never a secret value. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}
