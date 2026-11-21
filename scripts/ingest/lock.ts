import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.join(process.cwd(), "data");
const EPOCHS_DIR = path.join(DATA_DIR, "epochs");
const LOCK_DB_PATH = path.join(EPOCHS_DIR, ".publish.lock.db");

const lockContext = new AsyncLocalStorage<boolean>();
let inProcessLocked = false;

// OS-kernel inode lock via SQLite BEGIN EXCLUSIVE (POSIX fcntl on Linux/macOS/BSD across containers/bind mounts; LockFileEx on Windows)
export async function withPublishLock<T>(fn: () => Promise<T>): Promise<T> {
  if (lockContext.getStore() === true) {
    return fn();
  }
  if (inProcessLocked) {
    throw new Error(
      "Refusing concurrent ProChoice publication while exclusive OS publish lock is held",
    );
  }

  await fs.mkdir(EPOCHS_DIR, { recursive: true });
  inProcessLocked = true;
  let db: DatabaseSync | null = null;
  let txOpen = false;

  try {
    db = new DatabaseSync(LOCK_DB_PATH);
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec("PRAGMA journal_mode = DELETE;");
    try {
      db.exec("BEGIN EXCLUSIVE;");
      txOpen = true;
    } catch (err) {
      throw new Error(
        `Refusing concurrent ProChoice publication while exclusive OS lock ${LOCK_DB_PATH} is held`,
        { cause: err },
      );
    }

    return await lockContext.run(true, fn);
  } finally {
    if (db) {
      if (txOpen) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // ignore if connection already closed
        }
      }
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
    inProcessLocked = false;
  }
}
