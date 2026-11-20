/**
 * The permission contract, tested rather than promised.
 *
 * Users grant YOLO exactly once and then expect the agent to be able to look
 * anywhere — including a folder next to the workspace. A sandbox that still
 * refuses that is the bug behind "даже искать папки не может, хотя yolo стоит".
 */
import assert from 'node:assert/strict'
import { safeJoin } from '../src/main/fsops.ts'

// 1. without full access the workspace is a fence, and that is correct
assert.throws(() => safeJoin('/projects/winter', '../secret/.env', false), /outside every open folder|escapes workspace/)

// 2. with full access an absolute path anywhere resolves
assert.equal(safeJoin('/projects/winter', '/projects/other/mod/build.gradle', true), '/projects/other/mod/build.gradle')

// 3. relative paths still hang off the workspace: full access does not move the cwd
assert.equal(safeJoin('/projects/winter', 'src/Main.java', true), '/projects/winter/src/Main.java')

// 4. .. still climbs out deliberately, which is what "look next door" needs
assert.equal(safeJoin('/projects/winter', '../winterfall', true), '/projects/winterfall')

console.log('sandbox permissions: 4 checks passed')
