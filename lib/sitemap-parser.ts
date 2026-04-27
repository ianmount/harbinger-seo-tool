import type { SitemapNode } from "@/lib/types"

/**
 * Parses an indented text block representing the proposed sitemap into a tree.
 *
 * Accepted shapes (the parser auto-detects which one is in use):
 *   - Tabs as indents
 *   - 2-space indents
 *   - 4-space indents
 *
 * One page per line. Lines may carry a trailing parenthetical note that the
 * parser strips (e.g. `Drain Cleaning (new)`). Blank lines are skipped. Lines
 * starting with `#` or `//` are treated as comments and skipped.
 *
 * Throws if the input contains zero usable lines or if a child appears at a
 * deeper indent than its parent allows (skip-level indenting). Both are
 * usability errors that the UI surfaces inline so the user can fix them.
 */

export class SitemapParseError extends Error {
  readonly line: number | undefined
  constructor(message: string, line?: number) {
    super(message)
    this.name = "SitemapParseError"
    this.line = line
  }
}

const SLUG_RESERVED = new Set(["", "index", "home"])

function detectIndentUnit(rawLines: string[]): { kind: "tab" | "space"; size: number } {
  for (const raw of rawLines) {
    if (!raw || !raw.trim()) continue
    const match = raw.match(/^(\s+)/)
    if (!match) continue
    const ws = match[1]
    if (ws.includes("\t")) return { kind: "tab", size: 1 }
    if (ws.length === 4) return { kind: "space", size: 4 }
    return { kind: "space", size: 2 }
  }
  // No indented lines at all — every node is at depth 1 (children of root).
  return { kind: "space", size: 2 }
}

function indentDepth(raw: string, unit: { kind: "tab" | "space"; size: number }): number {
  const match = raw.match(/^(\s*)/)
  if (!match) return 0
  const ws = match[1]
  if (unit.kind === "tab") return ws.replace(/[^\t]/g, "").length
  // Spaces. Count leading spaces (after tab→spaces normalization), divide by unit.size.
  const expanded = ws.replace(/\t/g, " ".repeat(unit.size))
  return Math.floor(expanded.length / unit.size)
}

function stripTrailingNote(name: string): string {
  // "Drain Cleaning (new)" → "Drain Cleaning"
  // "Services - landing" → "Services"
  return name
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+[-–—]\s+.*$/, "")
    .trim()
}

export function slugifyPageName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (SLUG_RESERVED.has(slug)) return ""
  return slug
}

/**
 * Walk a node and assign full URL paths to each descendant. The root has no
 * URL; depth-1 nodes get `/<slug>` (or `/` for slug "" — the home page);
 * deeper nodes append their slug to their parent's URL path.
 */
function assignUrls(node: SitemapNode, parentUrl: string | null): void {
  for (const child of node.children) {
    let url: string
    if (child.proposedSlug === "") {
      // Home page — short-circuit to "/" only at depth 1.
      url = child.depth === 1 ? "/" : (parentUrl ?? "/")
    } else if (parentUrl == null || parentUrl === "/") {
      url = `/${child.proposedSlug}`
    } else {
      url = `${parentUrl}/${child.proposedSlug}`
    }
    // Stash the URL on the node via a side-channel map on the root — we do
    // this in `parseSitemapText` after the tree is built so the SitemapNode
    // type stays minimal.
    nodeUrls.set(child, url)
    assignUrls(child, url)
  }
}

const nodeUrls = new WeakMap<SitemapNode, string>()

/**
 * URL path for a node, computed by walking from root. Available immediately
 * after `parseSitemapText` returns. Returns "/" for the home page.
 */
export function urlFor(node: SitemapNode): string {
  return nodeUrls.get(node) ?? "/"
}

/** Flatten the tree to a list, depth-first, skipping the root sentinel. */
export function flattenSitemap(root: SitemapNode): SitemapNode[] {
  const out: SitemapNode[] = []
  const visit = (n: SitemapNode) => {
    if (n.depth > 0) out.push(n)
    for (const c of n.children) visit(c)
  }
  visit(root)
  return out
}

export function parseSitemapText(input: string): SitemapNode {
  const rawLines = input.split(/\r?\n/)
  const usable: { raw: string; line: number }[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue
    usable.push({ raw, line: i + 1 })
  }
  if (usable.length === 0) {
    throw new SitemapParseError("Sitemap is empty.")
  }

  const unit = detectIndentUnit(usable.map((u) => u.raw))

  const root: SitemapNode = {
    name: "",
    path: "",
    depth: 0,
    proposedSlug: "",
    children: [],
  }
  // Stack maps depth → node at that depth most recently seen.
  const stack: SitemapNode[] = [root]

  // Establish the base depth from the first line so users who indent the
  // entire block (e.g., pasted from a doc) still parse correctly.
  const firstDepth = indentDepth(usable[0].raw, unit)

  for (const { raw, line } of usable) {
    const rawDepth = indentDepth(raw, unit) - firstDepth
    if (rawDepth < 0) {
      throw new SitemapParseError(
        `Inconsistent indentation on line ${line}.`,
        line,
      )
    }
    const depth = rawDepth + 1 // depth 1 = top-level (children of root)
    const name = stripTrailingNote(raw.trim())
    if (!name) {
      throw new SitemapParseError(`Empty page name on line ${line}.`, line)
    }

    // The new node's parent must be at depth - 1. Pop until the stack top
    // matches; refuse to skip levels (a node at depth 3 with no depth-2
    // parent above it is a typo, not a valid tree).
    while (stack.length > depth) stack.pop()
    if (stack.length !== depth) {
      throw new SitemapParseError(
        `Line ${line} ("${name}") is indented past its parent. Indent one level at a time.`,
        line,
      )
    }
    const parent = stack[stack.length - 1]
    const proposedSlug = depth === 1 && /^home$/i.test(name) ? "" : slugifyPageName(name)
    const path = parent.depth === 0 ? name : `${parent.path} > ${name}`
    const node: SitemapNode = {
      name,
      path,
      depth,
      proposedSlug,
      children: [],
    }
    parent.children.push(node)
    stack.push(node)
  }

  assignUrls(root, null)
  return root
}

/**
 * Render the parsed tree back to indented text — useful for previewing the
 * parser's interpretation in the UI before the user submits.
 */
export function formatSitemapTree(root: SitemapNode): string {
  const lines: string[] = []
  const visit = (n: SitemapNode) => {
    if (n.depth > 0) {
      const indent = "  ".repeat(n.depth - 1)
      lines.push(`${indent}${n.name}  →  ${urlFor(n)}`)
    }
    for (const c of n.children) visit(c)
  }
  visit(root)
  return lines.join("\n")
}
