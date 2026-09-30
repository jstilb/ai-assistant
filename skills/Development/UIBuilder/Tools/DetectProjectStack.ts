#!/usr/bin/env bun
/**
 * DetectProjectStack.ts
 * Detects the actual project stack from package.json, tailwind.config.*, and components.json.
 * Returns a typed ProjectStack object. Used by UIBuilder workflows before applying design system defaults.
 *
 * Usage: bun ~/.claude/skills/Development/UIBuilder/Tools/DetectProjectStack.ts [projectRoot]
 */

import { existsSync, readFileSync } from "fs"
import { join, resolve } from "path"

export interface ProjectStack {
  framework: "next" | "vite" | "remix" | "cra" | "unknown"
  cssFramework: "tailwind" | "css-modules" | "styled-components" | "vanilla" | "unknown"
  componentLib: "shadcn" | "radix" | "mui" | "none" | "unknown"
  typescript: boolean
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>
  } catch (err) {
    console.error(
      `ERROR: Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

function detectFramework(deps: Record<string, unknown>, devDeps: Record<string, unknown>): ProjectStack["framework"] {
  const all = { ...deps, ...devDeps }
  if ("next" in all) return "next"
  if ("@remix-run/react" in all || "@remix-run/node" in all) return "remix"
  if ("vite" in all) return "vite"
  if ("react-scripts" in all) return "cra"
  return "unknown"
}

function detectCssFramework(
  deps: Record<string, unknown>,
  devDeps: Record<string, unknown>,
  projectRoot: string
): ProjectStack["cssFramework"] {
  const all = { ...deps, ...devDeps }
  if ("tailwindcss" in all) return "tailwind"
  // Also check for tailwind config files
  const tailwindConfigs = [
    "tailwind.config.ts",
    "tailwind.config.js",
    "tailwind.config.mjs",
    "tailwind.config.cjs",
  ]
  for (const cfg of tailwindConfigs) {
    if (existsSync(join(projectRoot, cfg))) return "tailwind"
  }
  if ("styled-components" in all) return "styled-components"
  // css-modules is not a package — detect by presence in source files indirectly
  // by checking if css-loader is configured with modules option (too complex here)
  // Fallback: if neither tailwind nor styled-components detected
  return "vanilla"
}

function detectComponentLib(
  deps: Record<string, unknown>,
  devDeps: Record<string, unknown>,
  projectRoot: string
): ProjectStack["componentLib"] {
  // shadcn marker: components.json in project root
  if (existsSync(join(projectRoot, "components.json"))) return "shadcn"
  const all = { ...deps, ...devDeps }
  if ("@radix-ui/react-primitive" in all || "@radix-ui/themes" in all) return "radix"
  if ("@mui/material" in all) return "mui"
  // Check for any @radix-ui/* dependency as signal of radix usage
  for (const key of Object.keys(all)) {
    if (key.startsWith("@radix-ui/")) return "radix"
  }
  return "none"
}

function detectTypeScript(
  deps: Record<string, unknown>,
  devDeps: Record<string, unknown>,
  projectRoot: string
): boolean {
  const all = { ...deps, ...devDeps }
  if ("typescript" in all) return true
  if (existsSync(join(projectRoot, "tsconfig.json"))) return true
  return false
}

function detectStack(projectRoot: string): ProjectStack {
  const packageJsonPath = join(projectRoot, "package.json")
  const packageJson = readJsonFile(packageJsonPath)

  if (!packageJson) {
    console.error(`ERROR: No package.json found at ${packageJsonPath}`)
    process.exit(1)
  }

  const deps = (packageJson.dependencies as Record<string, unknown>) ?? {}
  const devDeps = (packageJson.devDependencies as Record<string, unknown>) ?? {}

  const stack: ProjectStack = {
    framework: detectFramework(deps, devDeps),
    cssFramework: detectCssFramework(deps, devDeps, projectRoot),
    componentLib: detectComponentLib(deps, devDeps, projectRoot),
    typescript: detectTypeScript(deps, devDeps, projectRoot),
  }

  return stack
}

// Main
const projectRoot = resolve(process.argv[2] ?? process.cwd())
const stack = detectStack(projectRoot)
console.log(JSON.stringify(stack, null, 2))
