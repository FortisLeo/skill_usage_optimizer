const POLICY_PATTERNS = [/\bmust\b/i, /\bnever\b/i, /\balways\b/i, /\bdo not\b/i, /\brequired\b/i, /\bsecurity\b/i];

export function extractPolicyLines(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && POLICY_PATTERNS.some(pattern => pattern.test(line)));
}
