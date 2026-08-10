import { MemoryStorage } from '../../src/memory/index'
import { runStorageContract } from '../contract/storage-contract'

runStorageContract('MemoryStorage', () => new MemoryStorage())
