const IDENTIFIER_PATTERNS = [
  // JS/TS: function name(...)
  /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g,
  // JS/TS: const|let|var name = (...) => | function
  /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:\(|async\s*\()/g,
  // JS/TS: method call — client.method(...) or API.call(...)
  /(?:[a-zA-Z_$][\w$]*\s*\.\s*)([a-zA-Z_$][\w$]*)\s*\(/g,
  // JS/TS: class name
  /\bclass\s+([a-zA-Z_$][\w$]*)/g,
  // Python: def name(...)
  /\bdef\s+([a-zA-Z_][\w]*)\s*\(/g,
  // Python: import name or from name import
  /\bimport\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)/g,
  // Python: class Name
  /\bclass\s+([A-Za-z_][\w]*)\s*[:\(]/g,
  // CLI commands: command subcommand (two words after prompt)
  /\b(pg_dump|alembic|sqlite3|chrome|npm|npx|skill)\b/g,
  // Python: os.environ.get — extract get as a call
  /(?:os|sys|json|re|subprocess)\.([a-zA-Z_][\w]*)\s*\(/g,
];

export function extractIdentifiers(text: string): string[] {
  const ids = new Set<string>();
  for (const pattern of IDENTIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] && match[1].length >= 2 && !/^(const|let|var|function|import|class)$/i.test(match[1])) {
        ids.add(match[1].toLowerCase());
      }
    }
  }
  return [...ids].sort();
}

export function extractProvidedSymbols(text: string): string[] {
  const provided = new Set<string>();
  const patterns = [
    /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    /\bclass\s+([a-zA-Z_$][\w$]*)/g,
    /\bdef\s+([a-zA-Z_][\w]*)\s*\(/g,
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:\(|async\s*\()/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] && match[1].length >= 2) {
        provided.add(match[1].toLowerCase());
      }
    }
  }
  return [...provided].sort();
}

export function extractUsedSymbols(text: string): string[] {
  const used = new Set<string>();
  const patterns = [
    // Method calls: obj.method() or API.call()
    /(?:[a-zA-Z_][\w$]*\s*\.\s*)([a-zA-Z_][\w$]*)\s*\(/g,
    // Top-level API calls in code blocks: CDP({...}), client.Page.navigate(...)
    /\b([A-Z][a-zA-Z]*)\s*[\({]/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] && match[1].length >= 2 && !/^(const|let|var|function|new|return|if|for|while|switch|import|from|class)$/i.test(match[1])) {
        used.add(match[1].toLowerCase());
      }
    }
  }
  return [...used].sort();
}
