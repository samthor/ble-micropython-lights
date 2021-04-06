

/**
 * @template T
 */
class WorkQueue {
  #promise;
  #ready;

  /** @type {T[]} */
  #queue = [];

  constructor() {
    this.#promise = new Promise((r) => {
      this.#ready = r;
    });
  }

  /**
   * Waits until there is something in the queue. Returns immediately if something is already
   * in the queue.
   */
  async wait() {
    return this.#promise;
  }

  /**
   * @param {...T} items
   */
  push(...items) {
    if (items.length) {
      this.#queue.push(...items);
      this.#ready();
    }
  }

  /**
   * @return {T[]}
   */
  retrieve() {
    if (!this.#queue.length) {
      return [];
    }

    const local = this.#queue;
    this.#queue = [];

    this.#promise = new Promise((r) => {
      this.#ready = r;
    });

    return local;
  }

}


/**
 * @template T
 */
export class WorkQueueObject {
  /** @type {WorkQueue<boolean>} */
  #queue = new WorkQueue();

  /** @type {{[id: string]: T}} */
  #data = {};

  async wait() {
    return this.#queue.wait();
  }

  /**
   * @param {string} id
   * @param {T} v
   */
  add(id, v) {
    if (!Object.keys(this.#data).length) {
      this.#queue.push(true);
    }
    this.#data[id] = v;
  }

  /**
   * @return {{[id: string]: T}}
   */
  retrieve() {
    this.#queue.retrieve();
    const local = this.#data;
    this.#data = {};
    return local;
  }
}
