// Crash-recovery fixture: acquires the lock for a key and then hangs until
// the parent test kills the process, simulating a holder that dies
// mid-flight without releasing anything.
import { Redis } from 'ioredis'

import { RedisStorage } from '../../../src/redis/index'

const [hostArg = '127.0.0.1', portArg = '6379', keyArg = 'crash-key', ttlArg = '1500'] = process.argv.slice(2)

const client = new Redis({ host: hostArg, port: Number(portArg) })
const storage = new RedisStorage(client, { subscribe: false })

const winner = await storage.acquire(
  { key: keyArg, token: 'doomed-holder', storedAt: Date.now() },
  Number(ttlArg)
)
if (winner !== null) {
  process.stderr.write('fixture could not acquire the lock\n')
  process.exit(1)
}
process.stdout.write('HELD\n')
setInterval(() => {}, 1_000)
