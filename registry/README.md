# Registry entries (draft)

One folder per agent, laid out the way the [ACP registry](https://github.com/agentclientprotocol/registry) expects, ready to copy into a pull request there.

```
registry/<id>/agent.json   the listing: name, version, description, licence, how to launch (npx + provider argument)
registry/<id>/icon.svg     the icon shown in the agent dropdown
```

## Icons

The registry only accepts icons that are exactly 16x16, square and monochrome (`fill` and `stroke` may only be `currentColor`, `none` or `inherit`), so the IDE can recolour them for any theme. `test/icons.js` enforces this, along with plain-shape-only content and a margin inside the canvas, and keeps each `agent.json` in step with `package.json`.

The two icons here come from your own SVGs, normalized for that:

- The scaling that the original files did through `viewBox` (557 and 40 units wide, shown at 16) is applied to the path coordinates instead, so each file is a plain `0 0 16 16` icon with no transforms. Each path lands within 0.0005 px of where the scaling put it.
- `anonrouter.svg` had a lost separator in one path (`244.451117.617`, meant as `244.451 117.617`) that drew a stray spike at the top; that is fixed.
- `anonrouter.svg` filled the full 16 px width. It is scaled to 14 px wide and centred, so it keeps the 1 px margin IntelliJ icons normally leave. Venice already sat inside the margin and is only rescaled.
- Each shape is a separate `<path>`, so overlapping pieces always merge instead of cutting holes in each other.

## Before submitting

- The drafts already point at `WAGEDATWAR/incognito-agent`; update the four URLs in each `agent.json` if the repository is ever renamed or moved.
- Bump `version` and the pinned `package` together with `package.json` (the test fails if they drift).
- The ids (`anonrouter`, `venice`) and the npm package name are meant to change with the rebrand in the roadmap; do that first.
- The Anonrouter and Venice marks are those companies' trademarks. Get their permission, or switch to a neutral mark, before listing publicly.
