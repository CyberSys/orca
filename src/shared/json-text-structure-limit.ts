export type JsonTextStructureLimits = Readonly<{
  structuralTokens: number
  nestingDepth: number
}>

export class JsonTextStructureCapacityError extends Error {
  constructor(
    readonly resource: keyof JsonTextStructureLimits,
    readonly limit: number
  ) {
    super(
      resource === 'structuralTokens'
        ? `JSON structure exceeds ${limit} tokens`
        : `JSON nesting exceeds ${limit} levels`
    )
    this.name = 'JsonTextStructureCapacityError'
  }
}

export function assertJsonTextStructureWithinLimits(
  content: string,
  limits: JsonTextStructureLimits
): void {
  assertLimit(limits.structuralTokens)
  assertLimit(limits.nestingDepth)
  let structuralTokens = 0
  let depth = 0
  let inString = false
  let escaped = false

  // Why: this scans whole cache snapshots (tens of MB) on the main thread, so it
  // reads char codes rather than one-character substrings — same grammar, but
  // without a per-character string comparison chain.
  const length = content.length
  for (let index = 0; index < length; index += 1) {
    const code = content.charCodeAt(index)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (code === BACKSLASH) {
        escaped = true
      } else if (code === QUOTE) {
        inString = false
      }
      continue
    }
    if (code === QUOTE) {
      inString = true
      continue
    }
    if (!isStructuralToken(code)) {
      continue
    }
    structuralTokens += 1
    if (structuralTokens > limits.structuralTokens) {
      throw new JsonTextStructureCapacityError('structuralTokens', limits.structuralTokens)
    }
    if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      depth += 1
      if (depth > limits.nestingDepth) {
        throw new JsonTextStructureCapacityError('nestingDepth', limits.nestingDepth)
      }
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      depth = Math.max(0, depth - 1)
    }
  }
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('JSON structure limits must be non-negative safe integers')
  }
}

const QUOTE = 0x22
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_BRACKET = 0x5b
const BACKSLASH = 0x5c
const CLOSE_BRACKET = 0x5d
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d

function isStructuralToken(code: number): boolean {
  return (
    code === OPEN_BRACE ||
    code === CLOSE_BRACE ||
    code === OPEN_BRACKET ||
    code === CLOSE_BRACKET ||
    code === COMMA ||
    code === COLON
  )
}
