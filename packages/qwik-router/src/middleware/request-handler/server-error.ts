/** @public */
export class ServerError<T = any> extends Error {
  constructor(
    public status: number,
    public data: T
  ) {
    super(typeof data === 'string' ? data : undefined);
    if (data && typeof data === 'object') {
      Object.assign(this, data);
    }
  }
}
