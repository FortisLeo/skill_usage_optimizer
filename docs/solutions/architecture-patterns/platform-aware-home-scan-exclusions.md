---
title: Keep home scan exclusions platform-aware and root-relative
date: 2026-07-03
problem_type: architecture_pattern
track: knowledge
component: discovery
tags:
  - filesystem discovery
  - platform awareness
  - scan exclusions
  - home directories
applies_when:
  - A recursive discovery scan supports both project and home scopes.
  - Home-folder names differ by operating system or may appear legitimately below the home root.
  - Tests need deterministic behavior independent of the host operating system.
---

# Keep home scan exclusions platform-aware and root-relative

## Context

Project and home scans need different exclusion semantics. Project scope preserves the legacy basename exclusions at every depth, while home scope separates technical directories from user folders so nested folders with names such as `Library` or `Downloads` remain discoverable.

## Guidance

- Keep project exclusions unchanged and basename-based at every depth: `.git`, `node_modules`, `Library`, `Downloads`, `Trash`, `Caches`, `vendor`, `dist`, `build`, and `target`.
- Keep home technical exclusions basename-based at every depth: `.git`, `node_modules`, `Caches`, `vendor`, `dist`, `build`, and `target`.
- Match home user-folder exclusions against paths relative to the scan root, not against every basename.
- Use these root-relative lists:
  - common: `Desktop`, `Documents`, `Downloads`, `Music`, `Pictures`, `Public`, `Templates`, `Videos`
  - darwin: `Library`, `Movies`, `Applications`, `Trash`
  - win32: `AppData`, `Contacts`, `Favorites`, `Links`, `OneDrive`, `Saved Games`, `Searches`, `3D Objects`
  - linux: only the exact path `.local/share/Trash`
- Do not broadly exclude `.config`, `.local`, or `.local/share`; they can contain valid harness and skill roots.
- Accept `platform: NodeJS.Platform = process.platform` at the discovery boundary so tests can inject `darwin`, `win32`, or `linux` deterministically.
- Preserve the existing symlink rejection, realpath containment, maximum depth, scanned-entry limit, result limit, deduplication, and truncation safeguards.

## Why This Matters

Applying every home-folder name at every depth silently drops valid nested skills. Broadly excluding Unix configuration trees also hides known roots such as `.config/opencode/skills` and valid content under `.local/share`. Platform injection keeps this behavior testable without changing the machine running the suite.

## When to Apply

Use this pattern when a recursive filesystem feature scans a user's home directory across operating systems. Keep all-depth matching for technical or generated directories; reserve root-relative matching for conventional user folders whose names can be legitimate deeper in the tree.

## Examples

- On macOS, `~/Library` is skipped but `~/work/Library/skills` is scanned.
- On Linux, `~/.local/share/Trash` is skipped while `~/.local/share/skills` remains discoverable.
- A project scan still skips `Library`, `Downloads`, and other legacy excluded basenames wherever they occur.
- Validation passed: 13 focused tests; the full suite passed 20 files and 357 tests; typecheck and build passed.
