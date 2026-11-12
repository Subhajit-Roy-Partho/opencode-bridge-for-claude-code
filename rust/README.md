# Rust implementation

`rust/` is a port of `server.mjs` to Rust. **The Node original is kept and remains the reference**; both implementations expose the same ten tools, say the same things, and pass the same test suite.

| | Node (`server.mjs`) | Rust (`rust/`) |
|---|---|---|
| start to `initialize` reply (median of 15) | 35 ms | **7 ms** |
| resident memory of an idle server | 55 MB | **6 MB** |
| binary / runtime | needs Node 18+ | one 2.3 MB static-ish binary (glibc), no runtime |
| tests | 190 offline + 7 live | the **same** 190 offline + 7 live |

(Measured on Linux x86-64, Node 24, release build with LTO. Each Claude Code session starts its own bridge process, so the memory difference multiplies with the number of sessions.)

## Build

No toolchain needed beyond Docker:

```bash
rust/build.sh                  # -> ~/.cache/opencode-bridge-rust/target/release/opencode-bridge  (uses the rust:1-slim image)
OPENCODE_BRIDGE_RUST_CACHE=/big/disk rust/build.sh      # put the cargo cache and target dir elsewhere
```

or with a local toolchain: `cd rust && cargo build --release`. Dependencies: `serde_json`, `regex`, `libc`.

## Use

Register the binary instead of `node server.mjs`; the environment variables are the same:

```bash
claude mcp add --scope user opencode-bridge \
  -e OPENCODE_BRIDGE_ROOT="$HOME/projects" -e OPENCODE_BRIDGE_MODEL='provider/model#variant' \
  -- /path/to/opencode-bridge
```

## How the two stay identical

- **Shared texts.** The tool schemas, the policy and mode texts, the verification rules, the server `instructions`, the error classes (patterns and advice) and the secret patterns are not retyped in Rust: `rust/tools/dump_texts.mjs` exports them from `server.mjs` to `rust/data/texts.json`, which the binary embeds. `test/texts-sync.test.mjs` fails if the file is out of date, so a change to a text in Node cannot silently diverge. After changing any text: `node rust/tools/dump_texts.mjs`, rebuild.
- **Same tests.** `BRIDGE_BIN=/path/to/opencode-bridge npm test` runs the offline suite against the binary instead of `server.mjs`; `BRIDGE_BIN=... npm run test:live` does the same against a real opencode service. CI runs both implementations.

## Differences

- Lengths and clipping count Unicode characters; Node counts UTF-16 code units. They agree except for characters outside the Basic Multilingual Plane (emoji).
- Linux and macOS only (process groups, `/proc` or `ps`), like the Node version. Binaries are built for the machine they are built on (glibc); for a fully static binary build with the `x86_64-unknown-linux-musl` target.
- Requests are handled on threads, one per tool call (Node: the event loop). Behaviour is the same; there is no ordering guarantee between concurrent calls, as before.

## Layout

| file | role |
|---|---|
| `src/main.rs` | JSON-RPC loop, dispatch, response cap, signals and shutdown |
| `src/config.rs` | environment limits, embedded texts, error classification |
| `src/policy.rs` | routing-mode detection, tier / agent / secret enforcement, `opencode_policy` |
| `src/tasks.rs` | start / status / result / cancel / list: process groups, events, retry, timeout |
| `src/api.rs` | `opencode api` calls: timeout, 64 MB cap, error mapping, one retry of reads |
| `src/sessions.rs` | session list, output rendering, rename |
| `src/procs.rs` | process table |
| `src/util.rs` | helpers (JS-compatible number coercion, clipping, time, URL encoding) |
