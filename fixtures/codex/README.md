# Codex fixtures

`expected.md` files reflect the output of `serializeFrontmatter(result.frontmatter) + result.markdown` as returned by `codexSource.render()`. They omit `aceRenderedAt`, `sourcePath`, and `sourceMtime` because those fields are added by the core engine at write time and are not emitted by the renderer itself.
