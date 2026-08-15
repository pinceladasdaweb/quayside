/**
 * Captures the process warnings emitted while `work` runs. Warnings are
 * delivered on the next tick, so the listener stays attached across a couple
 * of turns before the messages are read back.
 */
export async function warningsDuring (work: () => Promise<void>): Promise<string[]> {
  const seen: string[] = []
  const capture = (warning: Error): void => { seen.push(warning.message) }
  // Node's own handler prints every warning; standing it down for the
  // duration keeps expected warnings out of the test output, where they
  // would drown a real failure.
  const printers = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', capture)
  try {
    await work()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('warning', capture)
    for (const printer of printers) process.on('warning', printer)
  }
  return seen
}
