/**
 * Path addressing inside a settings section.
 *
 * Shared by the Host gateway and the form planner: a write names a path, a
 * form marks a field overridden by the same path's PRESENCE in the user
 * layer, and those two meanings must not drift.
 * @module @omdsh-plugins/omdsh-plughub/settings-path
 */

/**
 * Read a nested value by path.
 * @param value - the root value.
 * @param path - key path from the root.
 * @returns the value at the path, or undefined along a missing branch.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Whether the raw user section carries this path — which is what "overridden"
 * means at the settings seam. Presence, never value comparison: an override
 * written to exactly the composition base is still an override, and the seam
 * treats it as one.
 * @param user - the raw user section, when one exists.
 * @param path - the field's path.
 * @returns true when the user layer has the key.
 */
export function isOverridden(user: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return false
  const parent = getPath(user, path.slice(0, -1))
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return false
  return Object.prototype.hasOwnProperty.call(parent, path[path.length - 1] as string)
}

/**
 * Whether two settings paths name the same slot.
 * @param left - one path.
 * @param right - the other.
 * @returns true when every segment matches.
 */
export function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}
