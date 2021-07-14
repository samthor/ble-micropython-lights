
export class SmartHomeError extends Error {

  /** @type {string} */
  code;

  constructor(code, message = '') {
    super(message);
    this.code = code;
  }

}

