/**
 * SQLite driver adapter — one thin interface over whichever builtin the
 * runtime ships. Bun → `bun:sqlite`; Node (≥22.5) → `node:sqlite`. The store
 * never cares which: it sees exec / prepare→(run|get|all) / close.
 *
 * Both builtins load through `createRequire` (never a static ESM import) so
 * neither `bun:` nor `node:sqlite` is resolved at module load: under Node the
 * `bun:` branch is dead code, under Bun the `node:sqlite` branch is dead code.
 */
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
function openNode(path) {
    const { DatabaseSync: Driver } = nodeRequire("node:sqlite");
    const db = new Driver(path);
    return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => {
            const statement = db.prepare(sql);
            return {
                run: (...params) => statement.run(...params),
                get: (...params) => statement.get(...params),
                all: (...params) => statement.all(...params),
            };
        },
        close: () => db.close(),
    };
}
function openBun(path) {
    const { Database: Driver } = nodeRequire("bun:sqlite");
    const db = new Driver(path, { create: true });
    return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => {
            const query = db.query(sql);
            return {
                run: (...params) => query.run(...params),
                get: (...params) => query.get(...params),
                all: (...params) => query.all(...params),
            };
        },
        close: () => db.close(),
    };
}
/** Open a SQLite connection on whichever builtin the runtime provides. */
export function openDb(path) {
    return globalThis.Bun !== undefined ? openBun(path) : openNode(path);
}
