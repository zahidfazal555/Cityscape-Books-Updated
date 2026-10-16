import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Private object storage for bill photos (Tech Spec §2). Keys are generated, never user input. */
export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new Error('invalid storage key');
}

/** Files under one directory (dev, CI, single-server installs). Production uses a bucket adapter. */
export class FileBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    assertKey(key);
    return path.join(this.dir, ...key.split('/'));
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // 'wx': never overwrite an existing object.
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.file(key));
  }
}

/** In-memory store for tests. */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, bytes: Buffer): Promise<void> {
    assertKey(key);
    if (this.objects.has(key)) throw new Error('object exists');
    this.objects.set(key, Buffer.from(bytes));
  }

  async get(key: string): Promise<Buffer> {
    const b = this.objects.get(key);
    if (!b) throw new Error('object not found');
    return b;
  }
}
