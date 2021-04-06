

const TASK_DELAY = 100;
const TASK_DELAY_MAX = 30_000;


/**
 * Runs a task forever.
 *
 * @param {string} name
 * @param {(success: () => void) => Promise<void>} task
 */
export async function runTask(name, task) {
  let failures = 0;
  const success = () => failures = 0;

  for (;;) {
    try {
      await task(success);
    } catch (e) {
      ++failures;
      const delay = ~~(Math.min(TASK_DELAY_MAX, TASK_DELAY ** failures) * (Math.random() + 0.5));
      console.warn('task', name, 'failed, delaying', delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}