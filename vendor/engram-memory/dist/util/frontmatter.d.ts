/**
 * A tiny, dependency-free frontmatter parser.
 *
 * It handles the subset of YAML that agent memory files actually use:
 *   - a leading `---` ... `---` block
 *   - top-level `key: value` pairs
 *   - one level of nesting (e.g. `metadata:` followed by indented `key: value`)
 *   - scalar coercion (numbers, booleans, quoted strings)
 *
 * It intentionally does NOT support the full YAML spec. For arbitrary YAML, plug
 * in `js-yaml` by replacing `parseFrontmatter`. Keeping it dependency-free is a
 * deliberate trade-off in service of "plug and play with zero install friction".
 */
export interface Frontmatter {
    data: Record<string, unknown>;
    body: string;
}
export declare function parseFrontmatter(text: string): Frontmatter;
//# sourceMappingURL=frontmatter.d.ts.map