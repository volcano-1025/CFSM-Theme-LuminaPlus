/**
 * 测试环境补丁：Node 26 自带的 `localStorage` 全局在没有 `--localstorage-file` 时不可用，
 * 且会遮住 jsdom 的实现。这里补一个内存版，让依赖本地存储的模块能在测试里正常跑。
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

function installStorage(target: typeof globalThis | Window) {
  const holder = target as unknown as Record<string, unknown>;
  if (holder.localStorage) return;
  Object.defineProperty(holder, "localStorage", {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
}

installStorage(globalThis);
if (typeof window !== "undefined") installStorage(window);
