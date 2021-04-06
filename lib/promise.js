
/**
 * @param {number} ms
 * @return {Promise<undefined>}
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(() => r(undefined), ms));
}
