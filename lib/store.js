"use strict";
/* Tiny JSON store with atomic writes. One file per key under data/. */
const fs = require("fs");
const path = require("path");

class Store {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(key) {
    return path.join(this.dir, key.replace(/[^a-z0-9_.-]/gi, "_") + ".json");
  }

  load(key, fallback) {
    if (this.cache.has(key)) return this.cache.get(key);
    let value = fallback;
    try {
      const raw = fs.readFileSync(this.file(key), "utf8");
      value = JSON.parse(raw);
    } catch (_) {}
    this.cache.set(key, value);
    return value;
  }

  save(key, value) {
    this.cache.set(key, value);
    const target = this.file(key);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
    return value;
  }

  update(key, fallback, fn) {
    const next = fn(this.load(key, fallback));
    return this.save(key, next);
  }
}

module.exports = { Store };
