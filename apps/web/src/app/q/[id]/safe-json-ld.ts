/**
 * Serialize a JSON-LD object for safe embedding inside an HTML <script>
 * element. JSON.stringify alone does not escape "</script>", so a value
 * carrying "</script><script>..." (for example an LLM or user supplied
 * route name) would break out of the script tag and run as markup. We
 * escape "<", ">", and "&" as unicode escapes, which is valid JSON and
 * renders identically once the browser parses the script content, but can
 * no longer terminate the surrounding element. Lives in its own module so
 * the regression test can run without pulling in next/navigation or prisma
 * from page.tsx.
 */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
