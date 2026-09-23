/**
 * Minimal ambient declarations for the Node built-ins the D1 test fake uses.
 *
 * tsconfig.worker.json restricts `types` to the generated Cloudflare bindings, so @types/node is
 * deliberately not part of the Worker program. Declaring only the handful of members the test
 * helper touches keeps the Worker typecheck honest without pulling Node's whole surface — and its
 * globals — into Worker code.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
