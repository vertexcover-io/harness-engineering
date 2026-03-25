import { redis } from "./redis-client";

type CacheEntry = {
  key: string;
  value: any;
  ttl: number;
  tags: string[];
  createdAt: Date;
};

const cache: Map<string, CacheEntry> = new Map();

export async function getOrSet(
  key: string,
  fetcher: () => Promise<any>,
  ttl: number,
  tags: string[]
): Promise<any> {
  const cached = cache.get(key);
  if (cached) {
    const age = Date.now() - cached.createdAt.getTime();
    if (age < cached.ttl * 1000) {
      return cached.value;
    }
  }

  const value = await fetcher();
  const entry: CacheEntry = {
    key,
    value,
    ttl,
    tags: tags,
    createdAt: new Date(),
  };
  cache.set(key, entry);
  await redis.set(key, JSON.stringify(value), "EX", ttl);
  return value;
}

// Invalidate all entries matching a tag
export function invalidateByTag(tag: string): void {
  cache.forEach((entry, key) => {
    if (entry.tags.includes(tag)) {
      cache.delete(key);
    }
  });
}

export async function warmCache(
  keys: string[],
  fetcher: (key: string) => Promise<any>,
  ttl: number
) {
  for (const key of keys) {
    try {
      const value = await fetcher(key);
      cache.set(key, {
        key,
        value,
        ttl,
        tags: [],
        createdAt: new Date(),
      });
      await redis.set(key, JSON.stringify(value), "EX", ttl);
    } catch (err) {
      // silently skip failed keys
      continue;
    }
  }
}

// Get cache stats
export function getStats() {
  let totalEntries = 0;
  let expiredEntries = 0;
  let totalSize = 0;
  cache.forEach((entry) => {
    totalEntries++;
    const age = Date.now() - entry.createdAt.getTime();
    if (age >= entry.ttl * 1000) {
      expiredEntries++;
    }
    totalSize += JSON.stringify(entry.value).length;
  });
  return { totalEntries, expiredEntries, totalSize };
}

export async function setWithRetry(key: string, value: any, ttl: number, maxRetries: number = 3): Promise<boolean> {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttl);
      cache.set(key, { key, value, ttl, tags: [], createdAt: new Date() } as CacheEntry);
      return true;
    } catch (e) {
      attempts++;
      if (attempts >= maxRetries) {
        return false;
      }
    }
  }
  return false;
}
